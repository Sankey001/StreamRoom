import os from 'node:os';

const VIRTUAL = /vEthernet|WSL|VirtualBox|VMware|Hyper-V|docker|Loopback/i;

/** Non-loopback IPv4 interfaces, real adapters (Wi-Fi / Ethernet) first. */
export function localIPv4s() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) list.push({ name, address: a.address, netmask: a.netmask, virtual: VIRTUAL.test(name) });
    }
  }
  return list.sort((a, b) => a.virtual - b.virtual);
}

export function primaryIp() {
  return localIPv4s()[0]?.address || '127.0.0.1';
}
