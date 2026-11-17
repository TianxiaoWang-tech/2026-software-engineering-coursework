import { LocalMockAdapter } from '../adapters/LocalMockAdapter';
import { DevicePort } from '../ports/DevicePort';

/**
 * The only place where the concrete device transport is chosen.
 *
 * Later phases:
 *   return HaAdapter.getInstance();   // Home Assistant WebSocket + REST gateway
 *   return MqttAdapter.getInstance(); // own broker + virtual devices on a PC / dev board
 * Pages and components stay unchanged because they only know DevicePort.
 */
export function getDevicePort(): DevicePort {
  return LocalMockAdapter.getInstance();
}
