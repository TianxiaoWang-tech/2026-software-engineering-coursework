/**
 * gateway/adapters/ac-gree/adapter.mjs
 * 格力空调适配器（示例码表）。
 */

import { BaseAcAdapter } from '../base.mjs';

const MODE_CODE = { cool: '0x01', heat: '0x02', dry: '0x03', fan: '0x04' };
const FAN_CODE = { auto: '0x00', low: '0x01', medium: '0x02', high: '0x03' };

export class GreeAdapter extends BaseAcAdapter {
  constructor({ logger = null, send }) {
    super({ logger, send });
    this.profileDef = {
      brand: 'gree',
      transport: 'ir',
      modes: ['cool', 'heat', 'dry', 'fan'],
      fanSpeeds: ['auto', 'low', 'medium', 'high'],
      swing: true,
      minTemp: 16,
      maxTemp: 30,
      tempStep: 1,
    };
  }

  encode({ capability, value }) {
    switch (capability) {
      case 'switch':
        return `GREE:PWR:${value ? 'ON' : 'OFF'}`;
      case 'hvac_mode':
        return `GREE:MODE:${MODE_CODE[value]}`;
      case 'fan_speed':
        return `GREE:FAN:${FAN_CODE[value]}`;
      case 'target_temp':
        return `GREE:TEMP:0x${Number(value).toString(16).padStart(2, '0')}`;
      case 'swing':
        return `GREE:SWING:${value ? 'ON' : 'OFF'}`;
      default:
        return `GREE:UNKNOWN:${capability}`;
    }
  }
}
