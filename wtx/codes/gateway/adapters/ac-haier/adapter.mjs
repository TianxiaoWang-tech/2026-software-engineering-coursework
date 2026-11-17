/**
 * gateway/adapters/ac-haier/adapter.mjs
 * 海尔空调适配器（示例码表）。
 * 与另两个品牌相比：不支持摆风、无 high 风速，用于验证"能力子集不同 → 界面置灰"。
 */

import { BaseAcAdapter } from '../base.mjs';

const MODE_CODE = { cool: '0x10', heat: '0x11', fan: '0x12' };
const FAN_CODE = { auto: '0x0A', low: '0x0B', medium: '0x0C' };

export class HaierAdapter extends BaseAcAdapter {
  constructor({ logger = null, send }) {
    super({ logger, send });
    this.profileDef = {
      brand: 'haier',
      transport: 'modbus',
      modes: ['cool', 'heat', 'fan'],
      fanSpeeds: ['auto', 'low', 'medium'],
      swing: false,
      minTemp: 16,
      maxTemp: 30,
      tempStep: 1,
    };
  }

  encode({ capability, value }) {
    switch (capability) {
      case 'switch':
        return `HAIER:PWR:${value ? 'ON' : 'OFF'}`;
      case 'hvac_mode':
        return `HAIER:MODE:${MODE_CODE[value]}`;
      case 'fan_speed':
        return `HAIER:FAN:${FAN_CODE[value]}`;
      case 'target_temp':
        return `HAIER:TEMP:${String(value)}`;
      default:
        return `HAIER:UNSUPPORTED:${capability}`;
    }
  }
}
