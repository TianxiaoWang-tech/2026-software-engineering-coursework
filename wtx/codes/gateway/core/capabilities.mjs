/**
 * gateway/core/capabilities.mjs
 * 能力目录 —— 设备类型到能力集的标准映射。
 *
 * 所有驱动、仿真器、业务模块都从这里取能力描述，保证
 * "同一类设备无论哪个品牌，对上层暴露的能力结构一致"（FR-3.5 / NFR-11）。
 */

const num = (kind, min, max, opts = {}) => ({
  kind,
  valueType: 'number',
  min,
  max,
  step: opts.step ?? 1,
  unit: opts.unit,
  readable: opts.readable ?? true,
  writable: opts.writable ?? false,
});

const boo = (kind, opts = {}) => ({
  kind,
  valueType: 'boolean',
  readable: opts.readable ?? true,
  writable: opts.writable ?? false,
});

const enm = (kind, values, opts = {}) => ({
  kind,
  valueType: 'enum',
  enumValues: values,
  readable: opts.readable ?? true,
  writable: opts.writable ?? false,
});

/* --------------------------- 各类设备能力 --------------------------- */

export const lightCapabilities = ({ dimming = true, colorTemp = false } = {}) => {
  const caps = [boo('switch', { writable: true })];
  if (dimming) caps.push(num('brightness', 1, 100, { unit: '%', writable: true }));
  if (colorTemp) caps.push(num('color_temp', 2700, 6500, { unit: 'K', step: 100, writable: true }));
  return caps;
};

/** 温湿度传感器 */
export const climateSensorCapabilities = () => [
  num('temperature', -20, 60, { unit: '℃' }),
  num('humidity', 0, 100, { unit: '%RH' }),
];

/** 人体感应 + 光照（照明中心的人体感应联动依赖这两项） */
export const motionSensorCapabilities = () => [boo('motion'), num('illuminance', 0, 2000, { unit: 'lux' })];

/**
 * 空调能力：按品牌能力子集裁剪（FR-3.3 不支持的模式置灰）
 * @param {{modes:string[], fanSpeeds:string[], swing:boolean, minTemp:number, maxTemp:number, step:number}} profile
 */
export const acCapabilities = (profile) => {
  const caps = [
    boo('switch', { writable: true }),
    enm('hvac_mode', profile.modes, { writable: true }),
    num('target_temp', profile.minTemp, profile.maxTemp, { unit: '℃', step: profile.step, writable: true }),
    enm('fan_speed', profile.fanSpeeds, { writable: true }),
  ];
  if (profile.swing) caps.push(boo('swing', { writable: true }));
  return caps;
};

/** 智能门禁 */
export const lockCapabilities = () => [
  boo('lock', { writable: true }),          // 下发开锁
  enm('lock_state', ['locked', 'unlocked']),
  enm('door_state', ['open', 'closed', 'ajar']),
];

/* --------------------------- 设备描述工厂 --------------------------- */

let seq = 0;
export const nextSimId = (prefix) => (seq += 1, `sim-${prefix}-${seq}`);

export function deviceDescriptor({
  id,
  name,
  category,
  capabilities,
  protocol = 'sim',
  driver = 'sim',
  brand,
  model,
  areaId,
  vendorRef,
}) {
  return {
    id,
    name,
    category,
    capabilities,
    protocol,
    driver,
    brand,
    model,
    areaId,
    vendorRef,
  };
}
