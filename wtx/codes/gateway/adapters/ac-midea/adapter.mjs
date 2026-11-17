/**
 * gateway/adapters/ac-midea/adapter.mjs
 * 美的空调适配器（示例码表）。
 * 与格力相比：不支持 fan 模式、无 medium 风速，可作为"能力子集差异"的验证样本。
 */

import { BaseAcAdapter } from '../base.mjs';

const MODE_CODE = { cool: '0x01', heat: '0x02', dry: '0x03' };
const FAN_CODE = { auto: '0x10', low: '0x11', high: '0x13' };

export class MideaAdapter extends BaseAcAdapter {
  constructor({ logger = null, send }) {
    super({ logger, send });
    this.profileDef = {
      brand: 'midea',
      transport: 'cloud_api',
      modes: ['cool', 'heat', 'dry'],
      fanSpeeds: ['auto', 'low', 'high'],
      swing: true,
      minTemp: 17,
      maxTemp: 30,
      tempStep: 1,
    };
  }

  encode({ capability, value }) {
    switch (capability) {
      case 'switch':
        return `MIDEA:PWR:${value ? '1' : '0'}`;
      case 'hvac_mode':
        return `MIDEA:MODE:${MODE_CODE[value]}`;
      case 'fan_speed':
        return `MIDEA:FAN:${FAN_CODE[value]}`;
      case 'target_temp':
        return `MIDEA:TEMP:${String(value)}`;
      case 'swing':
        return `MIDEA:SWING:${value ? '1' : '0'}`;
      default:
        return `MIDEA:UNKNOWN:${capability}`;
    }
  }
}
