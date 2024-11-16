const net = require('net');

let Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-panamax-m4315", "PanamaxM4315", PanamaxM4315);
};

class PanamaxM4315 {
  constructor(log, config) {
    this.log = log;
    this.name = config.name;
    this.ip = config.ip;
    this.port = 23; // Telnet port
    this.outlets = config.outlets || [];
    this.services = [];
    this.client = null;
    this.connected = false;
    this.outletStates = new Array(8).fill(false);
    this.pendingCommands = new Set();
    this.commandQueue = [];
    this.processingQueue = false;

    this.log.info('PanamaxM4315 plugin initialized');
    this.connect();
  }

  connect() {
    this.log.info(`Attempting to connect to ${this.ip}:${this.port}`);
    this.client = new net.Socket();

    this.client.connect(this.port, this.ip, () => {
      this.log.info('Connected to Panamax M4315');
      this.connected = true;
      this.pollOutletStates();
    });

    this.client.on('data', (data) => {
      this.log.debug(`Received data: ${data.toString().trim()}`);
      this.parseResponse(data.toString());
    });

    this.client.on('error', (error) => {
      this.log.error('Connection error:', error.message);
      this.connected = false;
    });

    this.client.on('close', () => {
      this.log.info('Connection closed. Attempting to reconnect...');
      this.connected = false;
      setTimeout(() => this.connect(), 5000);
    });
  }

  parseResponse(data) {
    const lines = data.split('\n');
    lines.forEach(line => {
      const match = line.trim().match(/^\$OUTLET(\d+) = (ON|OFF)/);
      if (match) {
        const outletNumber = parseInt(match[1]);
        const state = match[2] === 'ON';
        this.updateOutletState(outletNumber, state);
      }
    });
    this.pendingCommands.clear();
    this.processNextCommand();
  }

  updateOutletState(outletNumber, state) {
    if (this.outletStates[outletNumber - 1] !== state) {
      this.outletStates[outletNumber - 1] = state;
      const service = this.services.find(s => s.subtype === `outlet${outletNumber}`);
      if (service) {
        this.log.debug(`Updating outlet ${outletNumber} to ${state}`);
        service.getCharacteristic(Characteristic.On).updateValue(state);
      }
    }
  }

  getServices() {
    const informationService = new Service.AccessoryInformation();
    informationService
      .setCharacteristic(Characteristic.Manufacturer, "Panamax")
      .setCharacteristic(Characteristic.Model, "M4315")
      .setCharacteristic(Characteristic.SerialNumber, "123-456-789");

    this.services = [informationService];

    this.outlets.forEach((outlet, index) => {
      if (outlet.enabled) {
        const outletNumber = index + 1;
        const outletName = outlet.name || `Outlet ${outletNumber}`;
        const switchService = new Service.Switch(outletName, `outlet${outletNumber}`);
        
        switchService.setCharacteristic(Characteristic.Name, outletName);
        
        switchService
          .getCharacteristic(Characteristic.On)
          .on('get', (callback) => this.getState(outletNumber, callback))
          .on('set', (value, callback) => this.setState(outletNumber, value, callback));

        this.services.push(switchService);
      }
    });

    return this.services;
  }

  getState(outletNumber, callback) {
    this.log.debug(`Getting state for outlet ${outletNumber}`);
    if (!this.connected) {
      callback(new Error('Not connected to Panamax M4315'));
      return;
    }
    callback(null, this.outletStates[outletNumber - 1]);
  }

  setState(outletNumber, value, callback) {
    const outletName = this.outlets[outletNumber - 1].name || `Outlet ${outletNumber}`;
    this.log.info(`Setting ${outletName} (Outlet ${outletNumber}) to ${value ? 'ON' : 'OFF'}`);
    if (!this.connected) {
      callback(new Error('Not connected to Panamax M4315'));
      return;
    }

    const command = value ? `!SWITCH ${outletNumber} ON\r\n` : `!SWITCH ${outletNumber} OFF\r\n`;
    this.queueCommand(command, callback);
  }

  queueCommand(command, callback) {
    this.commandQueue.push({ command, callback });
    if (!this.processingQueue) {
      this.processNextCommand();
    }
  }

  processNextCommand() {
    if (this.commandQueue.length === 0) {
      this.processingQueue = false;
      return;
    }

    this.processingQueue = true;
    const { command, callback } = this.commandQueue.shift();

    if (this.pendingCommands.has(command)) {
      this.log.debug(`Command ${command.trim()} already pending, skipping`);
      callback(null);
      this.processNextCommand();
      return;
    }

    this.pendingCommands.add(command);
    this.log.debug(`Sending command: ${command.trim()}`);
    this.client.write(command, (err) => {
      if (err) {
        this.log.error('Error sending command:', err.message);
        this.pendingCommands.delete(command);
        callback(err);
        this.processNextCommand();
      } else {
        this.log.debug('Command sent successfully');
        callback(null);
        // Poll the states after a short delay to ensure we have the latest status
        setTimeout(() => {
          this.pollOutletStates();
          // Process next command after a delay to allow for device response
          setTimeout(() => this.processNextCommand(), 500);
        }, 500);
      }
    });
  }

  pollOutletStates() {
    if (!this.connected) return;

    const command = '?OUTLETSTAT\r\n';
    this.log.debug(`Polling outlet states: ${command.trim()}`);
    this.client.write(command, (err) => {
      if (err) {
        this.log.error('Error sending poll command:', err.message);
      } else {
        this.log.debug('Poll command sent successfully');
      }
    });
  }
}