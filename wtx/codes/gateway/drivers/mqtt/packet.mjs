/**
 * gateway/drivers/mqtt/packet.mjs
 * MQTT 3.1.1 报文编解码（最小可用子集）。
 *
 * 为什么自己写：赛题要求支持主流传输协议且网关需在 OpenHarmony 侧常驻，
 * 参考实现不引入 npm 依赖，保证零安装即可运行与测试；
 * ArkTS 侧对应 @ohos.net.socket + 同一套报文格式。
 *
 * 支持：CONNECT/CONNACK、PUBLISH(QoS0/1)、PUBACK、SUBSCRIBE/SUBACK、
 *       PINGREQ/PINGRESP、DISCONNECT，含遗嘱消息（LWT）。
 */

export const T = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
};

/** 剩余长度：7 位一组，最高位为续延标志 */
export function encodeLength(n) {
  const out = [];
  let x = n;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    out.push(byte);
  } while (x > 0);
  return Buffer.from(out);
}

export function encodeString(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function fixedHeader(type, flags, remainingLength) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(remainingLength)]);
}

export function buildConnect({
  clientId,
  keepalive = 60,
  clean = true,
  will, // {topic, payload, qos, retain}
  username,
  password,
}) {
  let flags = 0;
  if (clean) flags |= 0x02;
  if (will) {
    flags |= 0x04 | ((will.qos ?? 0) << 3) | (will.retain ? 0x20 : 0);
  }
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;

  const parts = [encodeString('MQTT'), Buffer.from([4, flags]), Buffer.alloc(2)];
  parts[2].writeUInt16BE(keepalive, 0);
  parts.push(encodeString(clientId));
  if (will) {
    parts.push(encodeString(will.topic));
    parts.push(encodeString(will.payload ?? ''));
  }
  if (username) parts.push(encodeString(username));
  if (password) parts.push(encodeString(password));

  const body = Buffer.concat(parts);
  return Buffer.concat([fixedHeader(T.CONNECT, 0, body.length), body]);
}

export function buildPublish({ topic, payload = '', qos = 0, retain = false, dup = false, packetId }) {
  const flags = (dup ? 0x08 : 0) | ((qos & 0x03) << 1) | (retain ? 0x01 : 0);
  const parts = [encodeString(topic)];
  if (qos > 0) {
    const pid = Buffer.alloc(2);
    pid.writeUInt16BE(packetId, 0);
    parts.push(pid);
  }
  parts.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'));
  const body = Buffer.concat(parts);
  return Buffer.concat([fixedHeader(T.PUBLISH, flags, body.length), body]);
}

export function buildSubscribe({ packetId, subs }) {
  const parts = [];
  const pid = Buffer.alloc(2);
  pid.writeUInt16BE(packetId, 0);
  parts.push(pid);
  for (const s of subs) {
    parts.push(encodeString(s.filter));
    parts.push(Buffer.from([s.qos & 0x03]));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([fixedHeader(T.SUBSCRIBE, 0x02, body.length), body]);
}

export function buildPuback(packetId) {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(packetId, 0);
  return Buffer.concat([fixedHeader(T.PUBACK, 0, 2), body]);
}

export function buildSuback({ packetId, granted }) {
  const pid = Buffer.alloc(2);
  pid.writeUInt16BE(packetId, 0);
  const body = Buffer.concat([pid, Buffer.from(granted)]);
  return Buffer.concat([fixedHeader(T.SUBACK, 0, body.length), body]);
}

export function buildConnack({ sessionPresent = false, code = 0 }) {
  return Buffer.concat([fixedHeader(T.CONNACK, 0, 2), Buffer.from([sessionPresent ? 1 : 0, code])]);
}

export const buildPingreq = () => Buffer.concat([fixedHeader(T.PINGREQ, 0, 0)]);
export const buildPingresp = () => Buffer.concat([fixedHeader(T.PINGRESP, 0, 0)]);
export const buildDisconnect = () => Buffer.concat([fixedHeader(T.DISCONNECT, 0, 0)]);

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

function readString(buf, offset) {
  const len = buf.readUInt16BE(offset);
  const start = offset + 2;
  return { value: buf.subarray(start, start + len).toString('utf8'), next: start + len };
}

/** 流式解析器：TCP 是字节流，必须处理粘包/半包 */
export class PacketParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /** 追加数据，返回本次解析出的完整报文数组 */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const packets = [];
    for (;;) {
      const parsed = this.parseOne();
      if (!parsed) break;
      packets.push(parsed);
      this.buffer = this.buffer.subarray(parsed.totalLength);
    }
    return packets;
  }

  parseOne() {
    if (this.buffer.length < 2) return null;
    const type = this.buffer[0] >> 4;
    const flags = this.buffer[0] & 0x0f;

    // 解析剩余长度
    let multiplier = 1;
    let remaining = 0;
    let index = 1;
    let digit;
    do {
      if (index >= this.buffer.length) return null; // 半包
      digit = this.buffer[index];
      remaining += (digit & 0x7f) * multiplier;
      multiplier *= 128;
      index += 1;
      if (multiplier > 128 * 128 * 128) throw new Error('malformed remaining length');
    } while (digit & 0x80);

    const totalLength = index + remaining;
    if (this.buffer.length < totalLength) return null; // 半包

    const body = this.buffer.subarray(index, totalLength);
    return { type, flags, body, totalLength };
  }
}

export function decodeConnack(body) {
  return { sessionPresent: (body[0] & 0x01) === 1, code: body[1] };
}

export function decodePublish(flags, body) {
  const qos = (flags >> 1) & 0x03;
  const retain = (flags & 0x01) === 1;
  const dup = (flags & 0x08) === 0x08;
  const t = readString(body, 0);
  let offset = t.next;
  let packetId;
  if (qos > 0) {
    packetId = body.readUInt16BE(offset);
    offset += 2;
  }
  return { topic: t.value, payload: body.subarray(offset), qos, retain, dup, packetId };
}

export function decodeSubscribe(body) {
  const packetId = body.readUInt16BE(0);
  const subs = [];
  let offset = 2;
  while (offset < body.length) {
    const t = readString(body, offset);
    subs.push({ filter: t.value, qos: body[t.next] & 0x03 });
    offset = t.next + 1;
  }
  return { packetId, subs };
}

export function decodeSuback(body) {
  return { packetId: body.readUInt16BE(0), granted: [...body.subarray(2)] };
}

export function decodeConnect(body) {
  let offset = 0;
  const proto = readString(body, offset);
  offset = proto.next;
  const level = body[offset];
  const flags = body[offset + 1];
  const keepalive = body.readUInt16BE(offset + 2);
  offset += 4;

  const clientId = readString(body, offset);
  offset = clientId.next;

  let will;
  if (flags & 0x04) {
    const wt = readString(body, offset);
    offset = wt.next;
    const wp = readString(body, offset);
    offset = wp.next;
    will = { topic: wt.value, payload: wp.value, qos: (flags >> 3) & 0x03, retain: (flags & 0x20) === 0x20 };
  }

  let username;
  if (flags & 0x80) {
    const u = readString(body, offset);
    username = u.value;
    offset = u.next;
  }
  let password;
  if (flags & 0x40) {
    const p = readString(body, offset);
    password = p.value;
    offset = p.next;
  }

  return {
    protocol: proto.value,
    level,
    clean: (flags & 0x02) === 0x02,
    keepalive,
    clientId: clientId.value,
    will,
    username,
    password,
  };
}

/** 主题过滤匹配：+ 单层、# 多层（仅末尾） */
export function topicMatches(filter, topic) {
  if (filter === topic) return true;
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i += 1) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] === '+') continue;
    if (f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}
