import { Service, PlatformAccessory, APIEvent } from 'homebridge';
import { MATouchPlatform } from './platform';
import { Peripheral } from '@abandonware/noble';

/**
 * Constants
 */
const MA_SERVICE = '0277df18e79611e6bf01fe55135034f3';

const MA_CHAR = {
  FIRMWARE_VERSION: '799e3b22e79711e6bf01fe55135034f3', // handle = 0x0012, char properties = 0x02, char value handle = 0x0013
  SOFTWARE_VERSION: 'def9382ae79511e6bf01fe55135034f3', // handle = 0x0014, char properties = 0x02, char value handle = 0x0015
  WRITE: 'e48c1528e79511e6bf01fe55135034f3', // handle = 0x0016, char properties = 0x0c, char value handle = 0x0017
  READ: 'ea1ea690e79511e6bf01fe55135034f3', // handle = 0x0018, char properties = 0x10, char value handle = 0x0019
};

const MODE_MASK = {
  POWER: (1 << 0),
  FAN: (1 << 1),
  COOL: (1 << 3),
  HEAT: (1 << 4),
  DRY: (1 << 5),
  AUTO: (1 << 6),
};

/**
 * Platform Accessory
 */
export class MATouchPlatformAccessory {
  private service: Service;
  private pin: Buffer;
  private updateTimeout: NodeJS.Timeout;
  private msgid = 0;
  private receiveLength = 0;
  private receiveBuffer = Buffer.alloc(0);
  private receiveResolve;
  private updateFailCount = 0;
  private isShutdown = false;

  private currentState = {
    Active: 0,
    CurrentHeaterCoolerState: 0,
    TargetHeaterCoolerState: 0,
    CurrentTemperature: 10,
    CoolingThresholdTemperature: 16,
    HeatingThresholdTemperature: 16,
    RotationSpeed: 100,
    SwingMode: 0,
  };

  private changedState = {
    Active: false,
    TargetHeaterCoolerState: false,
    CoolingThresholdTemperature: false,
    HeatingThresholdTemperature: false,
    RotationSpeed: false,
    SwingMode: false,
  };

  constructor(
    private readonly platform: MATouchPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly peripheral: Peripheral,
  ) {
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Mitsubishi Electric')
      .setCharacteristic(this.platform.Characteristic.Model, 'PAR-CT01MAU')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, peripheral.advertisement.localName.substring(12));

    // get the Thermostat service if it exists, otherwise create a new Thermostat service
    this.service = this.accessory.getService(this.platform.Service.HeaterCooler) || this.accessory.addService(this.platform.Service.HeaterCooler);

    // set the service name, this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(this.platform.Characteristic.Name, peripheral.advertisement.localName);

    // register handlers for the Heater Cooler Characteristics
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.handleActiveGet.bind(this))
      .onSet(this.handleActiveSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.handleCurrentHeaterCoolerStateGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .onGet(this.handleTargetHeaterCoolerStateGet.bind(this))
      .onSet(this.handleTargetHeaterCoolerStateSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({ minStep: 0.5, minValue: 10, maxValue: 29 })
      .onGet(this.handleHeatingThresholdTemperatureGet.bind(this))
      .onSet(this.handleHeatingThresholdTemperatureSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps({ minStep: 0.5, minValue: 16, maxValue: 31 })
      .onGet(this.handleCoolingThresholdTemperatureGet.bind(this))
      .onSet(this.handleCoolingThresholdTemperatureSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minStep: 25, minValue: 0, maxValue: 100 })
      .onGet(this.handleRotationSpeedGet.bind(this))
      .onSet(this.handleRotationSpeedSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(this.handleSwingModeGet.bind(this))
      .onSet(this.handleSwingModeSet.bind(this));

    this.service.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);

    this.pin = this.pinToBase10Hex(this.platform.config.pin || 0);

    // Update characteristics values asynchronously
    this.updateTimeout = setTimeout(async () => await this.update(), 250);

    this.platform.api.on(APIEvent.SHUTDOWN, () => {
      clearTimeout(this.updateTimeout);
      this.isShutdown = true;
    });
  }

  // MARK: - Updates

  async update() {
    if (this.isShutdown) {
      return;
    }

    clearTimeout(this.updateTimeout);
    this.updateTimeout = setTimeout(async () => await this.update(), 10000);

    const statusFault = (this.updateFailCount >= 3) ? this.platform.Characteristic.StatusFault.GENERAL_FAULT : this.platform.Characteristic.StatusFault.NO_FAULT;
    this.service.updateCharacteristic(this.platform.Characteristic.StatusFault, statusFault);

    if (this.peripheral.state === 'connected') {
      await this.peripheral.disconnectAsync();
    }

    try {
      this.platform.log.debug('Connecting to', this.peripheral.uuid, '...');
      this.updateFailCount++;
      this.peripheral.cancelConnect();
      await this.peripheral.connectAsync();
      this.platform.log.debug('State:', this.peripheral.state);
    } catch (error) {
      this.platform.log.error('Connection failed:', error, 'state:', this.peripheral.state);
      return;
    }

    try {
      const [firmwareVerChar, softwareVerChar, writeChar, readChar] = (await this.peripheral.discoverSomeServicesAndCharacteristicsAsync([MA_SERVICE], [MA_CHAR.FIRMWARE_VERSION, MA_CHAR.SOFTWARE_VERSION, MA_CHAR.WRITE, MA_CHAR.READ])).characteristics;

      const firmwareVersion = await firmwareVerChar.readAsync();
      this.platform.log.debug('MA Firmware Version:', firmwareVersion.toString());
      this.accessory.getService(this.platform.Service.AccessoryInformation)!
        .updateCharacteristic(this.platform.Characteristic.SoftwareRevision, firmwareVersion.toString()); // intentionally swapped with FirmwareRevision

      const softwareVersion = await softwareVerChar.readAsync();
      this.platform.log.debug('MA Software Version:', softwareVersion, softwareVersion.toString());
      this.accessory.getService(this.platform.Service.AccessoryInformation)!
        .updateCharacteristic(this.platform.Characteristic.FirmwareRevision, softwareVersion.toString()); // intentionally swapped with SoftwareRevision

      readChar.notify(true);
      readChar.on('data', async (data) => {
        this.platform.log.debug('RCV:', data, this.receiveLength);

        if (this.receiveLength === 0) {
          const len = data.readUInt8();
          // TODO: check checksum, maybe trim it off the message
          this.receiveBuffer = Buffer.alloc(len);
          data.copy(this.receiveBuffer, 0, 2);
          this.receiveLength += data.length - 2;
        } else {
          data.copy(this.receiveBuffer, this.receiveLength);
          this.receiveLength += data.length;
        }

        if (this.receiveBuffer.length === this.receiveLength) {
          await this.receivedMessage(this.receiveBuffer);
          this.receiveLength = 0;
        }
      });

      // let's talk...
      // TODO: figure out what these do & error checking
      await this.sendCommand(writeChar, Buffer.from([0x01, 0x00, 0x01, this.pin[0], this.pin[1], 0x00, 0x00, 0x00]));
      await this.sendCommand(writeChar, Buffer.from([0x03, 0x00, 0x01, this.pin[0], this.pin[1], 0x00, 0x00, 0x00]));
      // await this.sendCommand(writeChar, Buffer.from([0x01, 0x03, 0x01, this.pin[0], this.pin[1], 0x00, 0x00, 0x00]));
      // await this.sendCommand(writeChar, Buffer.from([0x05, 0x00, 0x00])); // not sure?
      // await this.sendCommand(writeChar, Buffer.from([0x03, 0x03, 0x01, this.pin[0], this.pin[1], 0x00, 0x00, 0x00]));
      await this.sendCommand(writeChar, Buffer.from([0x01, 0x04, 0x01, this.pin[0], this.pin[1], 0x00, 0x00, 0x00]));

      if (this.changedState.Active) {
        if (await this.maSetPower(writeChar, this.currentState.Active === this.platform.Characteristic.Active.ACTIVE) !== true) {
          this.platform.log.error('Failed to set power!');
        }
        this.changedState.Active = false;
      }

      if (this.changedState.TargetHeaterCoolerState) {
        if (await this.maSetMode(writeChar, this.targetHeaterCoolerStateToMAMode(this.currentState.TargetHeaterCoolerState)) !== true) {
          this.platform.log.error('Failed to set mode!');
        }
        this.changedState.TargetHeaterCoolerState = false;
      }

      if (this.changedState.CoolingThresholdTemperature) {
        if (await this.maSetCoolingSetpoint(writeChar, this.currentState.CoolingThresholdTemperature) !== true) {
          this.platform.log.error('Failed to set cooling setpoint!');
        }
        this.changedState.CoolingThresholdTemperature = false;
      }

      if (this.changedState.HeatingThresholdTemperature) {
        if (await this.maSetHeatingSetpoint(writeChar, this.currentState.HeatingThresholdTemperature) !== true) {
          this.platform.log.error('Failed to set heating setpoint!');
        }
        this.changedState.HeatingThresholdTemperature = false;
      }

      if (this.changedState.RotationSpeed) {
        if (await this.maSetFanMode(writeChar, this.rotationSpeedToMAFanMode(this.currentState.RotationSpeed)) !== true) {
          this.platform.log.error('Failed to set fan mode!');
        }
        this.changedState.RotationSpeed = false;
      }

      if (this.changedState.SwingMode) {
        if (await this.maSetVaneMode(writeChar, this.swingModeToMAVaneMode(this.currentState.SwingMode)) !== true) {
          this.platform.log.error('Failed to set swing mode!');
        }
        this.changedState.SwingMode = false;
      }

      await this.readStatus(writeChar);

      // TODO: figure out what these do & error checking
      await this.sendCommand(writeChar, Buffer.from([0x03, 0x04, 0x01, this.pin[0], this.pin[1], 0x00, 0x00, 0x00]));
      await this.sendCommand(writeChar, Buffer.from([0x01, 0x01, 0x01, this.pin[0], this.pin[1], 0x00, 0x00, 0x00]));
      await this.sendCommand(writeChar, Buffer.from([0x03, 0x01, 0x01, this.pin[0], this.pin[1], 0x00, 0x00, 0x00]));

      this.platform.log.debug('Disconnecting!');
      await this.peripheral.disconnectAsync();
      this.updateFailCount = 0;
    } catch (error) {
      this.platform.log.error('Communications error in update():', error);
      await this.peripheral.disconnectAsync();
    }
  }

  // MARK: - Communications

  // [2: length] [1: msgid] [l: body] [2: cksum]
  async sendCommand(characteristic, body) : Promise<Buffer> {
    return new Promise<Buffer>((resolve) => {
      const buffer = Buffer.alloc(2 + 1 + body.length + 2);
      buffer.writeUInt16LE(1 + body.length + 2, 0);
      buffer.writeUInt8(this.msgid, 2);
      body.copy(buffer, 3);
      buffer.writeUInt16LE(this.checksum(buffer), buffer.length - 2);
      //this.platform.log.debug('Full packet:', buffer, buffer.length);
      for (let i = 0; i < buffer.length; i += 20) {
        const part = buffer.slice(i, Math.min(buffer.length, i + 20));
        this.platform.log.debug('SND:', part, i, buffer.length - i);
        characteristic.write(part, true); // TODO: handle thrown errors here and other places
      }
      this.msgid += 1;
      if (this.msgid > 7) {
        this.msgid = 0;
      }
      this.receiveResolve = resolve;
    });
  }

  async receivedMessage(data) {
    //this.platform.log.debug('Message:', data);
    if (this.receiveResolve) {
      this.receiveResolve(data);
      this.receiveResolve = undefined;
    } else {
      this.platform.log.error('Received an unsolicited notification!');
    }
  }

  // MARK: - Control

  async maControlCommand(c, flagsA, flagsB, flagsC, mode, coolSetpoint, heatSetpoint, vaneMode, fanMode) : Promise<boolean> {
    // off:        05 0101 0100 0010 4502 1002 9001 4002 9001 6400 00
    // on:         05 0101 0100 0011 4502 1002 9001 4002 9001 6400 00
    // mode auto:  05 0101 0200 0079 4502 1002 9001 4002 9001 6400 00
    // mode cool:  05 0101 0200 0009 4502 1002 9001 4002 9001 6400 00
    // mode heat:  05 0101 0200 0011 4502 1002 9001 4002 9001 6400 00
    // mode dry:   05 0101 0200 0031 4502 1002 9001 4002 9001 6400 00
    // mode fan:   05 0101 0200 0001 4502 1002 9001 4002 9001 6400 00
    // heat setp:  05 0101 0002 0011 4502 2002 9001 4002 9001 6400 00
    // cool setp:  05 0101 0001 0009 4002 1002 9001 4002 9001 6400 00
    // fan auto:   05 0101 0000 0111 4502 1002 9001 4002 9001 6400 00
    // fan high:   05 0101 0000 0111 4502 1002 9001 4002 9001 6300 00
    // fan medium: 05 0101 0000 0111 4502 1002 9001 4002 9001 6200 00
    // fan low:    05 0101 0000 0111 4502 1002 9001 4002 9001 6000 00
    // vane auto:  05 0101 0000 0211 4502 1002 9001 4002 9001 6400 00
    // vane swing: 05 0101 0000 0211 4502 1002 9001 4002 9001 7400 00 <-- so 7 is vane, 4 is fan
    const cool = this.numberToBase10Hex(coolSetpoint);
    const heat = this.numberToBase10Hex(heatSetpoint);
    const result = await this.sendCommand(c, Buffer.from([0x05, 0x01, 0x01, flagsA, flagsB, flagsC, mode, cool[0], cool[1], heat[0], heat[1], 0x90, 0x01, 0x40, 0x02, 0x90, 0x01, (vaneMode << 4) + fanMode, 0x00, 0x00]));
    return (result.readUInt8(1) === 0x05 && result.readUInt8(2) === 0x00 && result.readUInt8(3) === 0x01);
  }

  async maSetPower(c, yorn) : Promise<boolean> {
    return await this.maControlCommand(c, 0x01, 0x00, 0x00, yorn ? 0x11 : 0x10, this.currentState.CoolingThresholdTemperature, this.currentState.HeatingThresholdTemperature, this.currentState.SwingMode ? 0x7 : 0x6, this.rotationSpeedToMAFanMode(this.currentState.RotationSpeed));
  }

  async maSetMode(c, mode) : Promise<boolean> {
    return await this.maControlCommand(c, 0x02, 0x00, 0x00, mode, this.currentState.CoolingThresholdTemperature, this.currentState.HeatingThresholdTemperature, this.currentState.SwingMode ? 0x7 : 0x6, this.rotationSpeedToMAFanMode(this.currentState.RotationSpeed));
  }

  async maSetCoolingSetpoint(c, coolingSetpoint) : Promise<boolean> {
    return await this.maControlCommand(c, 0x00, 0x01, 0x00, this.targetHeaterCoolerStateToMAMode(this.currentState.TargetHeaterCoolerState), coolingSetpoint, this.currentState.HeatingThresholdTemperature, this.currentState.SwingMode ? 0x7 : 0x6, this.rotationSpeedToMAFanMode(this.currentState.RotationSpeed));
  }

  async maSetHeatingSetpoint(c, heatingSetpoint) : Promise<boolean> {
    return await this.maControlCommand(c, 0x00, 0x02, 0x00, this.targetHeaterCoolerStateToMAMode(this.currentState.TargetHeaterCoolerState), this.currentState.CoolingThresholdTemperature, heatingSetpoint, this.currentState.SwingMode ? 0x7 : 0x6, this.rotationSpeedToMAFanMode(this.currentState.RotationSpeed));
  }

  async maSetFanMode(c, rotationSpeed) : Promise<boolean> {
    return await this.maControlCommand(c, 0x00, 0x00, 0x01, this.targetHeaterCoolerStateToMAMode(this.currentState.TargetHeaterCoolerState), this.currentState.CoolingThresholdTemperature, this.currentState.HeatingThresholdTemperature, this.swingModeToMAVaneMode(this.currentState.SwingMode), rotationSpeed);
  }

  async maSetVaneMode(c, vaneMode) : Promise<boolean> {
    return await this.maControlCommand(c, 0x00, 0x00, 0x02, this.targetHeaterCoolerStateToMAMode(this.currentState.TargetHeaterCoolerState), this.currentState.CoolingThresholdTemperature, this.currentState.HeatingThresholdTemperature, vaneMode, this.rotationSpeedToMAFanMode(this.currentState.RotationSpeed));
  }

  // MARK: - Status

  async readStatus(c) : Promise<boolean> {
    // __ __ 0e 05 00 02 00 00 00 32 10 03 60 01 90 02 00 01 10 03
    // 60 01 10 03 80 01 90 02 60 01 40 02 10 02 90 01 40 02 90 01
    // 40 06 00 00 00 00 00 20 02 01 00 10 04 __ __

    // __ __ 0d 05 00 02 00 00 00 12 80 02 00 02 60 02 60 01 10 03
    // 60 01 10 03 80 01 90 02 60 01 40 02 10 02 90 01 40 02 90 01
    // 40 06 00 00 00 00 00 20 02 01 00 14 04 __ __

    // 7: mode
    // 8-9: cool max temp
    // 10-11: cool min temp
    // 12-13: heat max temp
    // 14-15: heat min temp
    // 16-17: 31.0? [unknown temp?]
    // 18-19: 16.0? [unknown temp?]
    // 20-21: 31.0? [unknown temp?]
    // 22-23: 18.0? [unknown temp?]
    // 24-25: 29.0? [unknown temp?]
    // 26-27: 16.0? [unknown temp?]
    // 28-29: target cool temp
    // 30-31: target heat temp
    // 32-33: 19.0? [unknown temp?]
    // 34-35: 24.0? [unknown temp?]
    // 36-37: 19.0? [unknown temp?]
    // 38: fan mode
    // 39: vane mode
    // 40-43: zeroes? [unknown]
    // 44: hold
    // 45-46: room temp
    // 47: 0x01? [unknown]
    // 48: 0x00? [unknown]
    // 49: 0x14 or 0x04 or other? [flags?] bit2:temp_restriction
    // 50: 0x04? [unknown]

    const data = await this.sendCommand(c, Buffer.from([0x05, 0x02, 0x00]));

    if (data.readUInt8(1) !== 0x05 || data.readUInt8(2) !== 0x00 || data.readUInt8(3) !== 0x02) {
      if (data.readUInt8(2) === 0x09) { // in menus: 0c 05 09 02 00 10 54 89 00
        this.platform.log.info('Thermostat is in menus or unavailable, status could not be refreshed.');
        return false;
      }
      this.platform.log.error('Invalid status reply:', data);
      return false;
    }
    if (!(data.readUInt8(1) === 0x05 && data.readUInt8(2) === 0x00) || data.length !== 0x35) {
      this.platform.log.error('Invalid status reply:', data); // 0c 05 09 02 00 10 54 89 00
      return false;
    }

    const mode = data.readUInt8(7);
    this.currentState.Active = ((mode & MODE_MASK.FAN) !== 0) ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;

    if ((mode & MODE_MASK.AUTO) !== 0) {
      this.currentState.TargetHeaterCoolerState = this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
    } else if ((mode & MODE_MASK.COOL) !== 0 && (mode & MODE_MASK.DRY) === 0) {
      this.currentState.TargetHeaterCoolerState = this.platform.Characteristic.TargetHeaterCoolerState.COOL;
    } else if ((mode & MODE_MASK.HEAT) !== 0 && (mode & MODE_MASK.DRY) === 0) {
      this.currentState.TargetHeaterCoolerState = this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
    } else { // no matching homekit mode, so say we're off
      this.currentState.Active = this.platform.Characteristic.Active.INACTIVE;
    }

    /*this.platform.log.debug('Mode/State:', mode.toString(16));
    this.platform.log.debug(
      '7:', (mode & (1 << 7)) !== 0,
      'A:', (mode & MODE_MASK.AUTO) !== 0,
      'D:', (mode & MODE_MASK.DRY) !== 0,
      'H:', (mode & MODE_MASK.HEAT) !== 0,
      'C:', (mode & MODE_MASK.COOL) !== 0,
      '2:', (mode & (1 << 2)) !== 0,
      'F:', (mode & MODE_MASK.FAN) !== 0,
      'P:', (mode & MODE_MASK.POWER) !== 0
    );*/
    this.platform.log.debug('Active:', this.currentState.Active);
    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.currentState.Active);
    this.platform.log.debug('TargetHeaterCoolerState:', this.currentState.TargetHeaterCoolerState);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState, this.currentState.TargetHeaterCoolerState);

    const maxCoolTemp = this.numberFromBase10Hex(data, 8);
    const minCoolTemp = this.numberFromBase10Hex(data, 10);
    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps({ minStep: 0.5, minValue: minCoolTemp, maxValue: maxCoolTemp });

    const maxHeatTemp = this.numberFromBase10Hex(data, 12);
    const minHeatTemp = this.numberFromBase10Hex(data, 14);
    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({ minStep: 0.5, minValue: minHeatTemp, maxValue: maxHeatTemp });

    const targetCoolTemp = this.numberFromBase10Hex(data, 28);
    this.platform.log.debug('CoolingThresholdTemperature:', targetCoolTemp);
    this.currentState.CoolingThresholdTemperature = targetCoolTemp;
    this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.currentState.CoolingThresholdTemperature);

    const targetHeatTemp = this.numberFromBase10Hex(data, 30);
    this.platform.log.debug('HeatingThresholdTemperature:', targetHeatTemp);
    this.currentState.HeatingThresholdTemperature = targetHeatTemp;
    this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, this.currentState.HeatingThresholdTemperature);

    const fanMode = data.readUInt8(38) >> 4;
    this.currentState.RotationSpeed = this.maFanModeToRotationSpeed(fanMode);
    this.platform.log.debug('RotationSpeed:', this.currentState.RotationSpeed);
    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.currentState.RotationSpeed);

    const vaneMode = data.readUInt8(39);
    this.currentState.SwingMode = this.maVaneModeToSwingMode(vaneMode);
    this.platform.log.debug('SwingMode:', this.currentState.SwingMode);
    this.service.updateCharacteristic(this.platform.Characteristic.SwingMode, this.currentState.SwingMode);

    const hold = data.readUInt8(44);
    this.platform.log.debug('Hold:', hold.toString(16));

    const roomTemp = this.numberFromBase10Hex(data, 45);
    this.platform.log.debug('CurrentTemperature:', roomTemp);
    this.currentState.CurrentTemperature = roomTemp;
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.currentState.CurrentTemperature);

    const unknown47 = data.readUInt8(47);
    this.platform.log.debug('Unknown47 (usually 0x01):', unknown47.toString(16));

    const unknown48 = data.readUInt8(48);
    this.platform.log.debug('Unknown48 (usually 0x00):', unknown48.toString(16));

    // 0x10: on
    // 0x00: off
    // 0x4: off, temp restrict
    // 0x14: on, temp restrict
    const flags = data.readUInt8(49);
    const tempRestrict = ((flags & (1 << 2)) !== 0);
    const maybePower = ((flags & (1 << 4)) !== 0);
    this.platform.log.debug('Flags:', flags.toString(16), '[ Temp Restrict:', tempRestrict, 'Power:', maybePower, ']');

    const unknown2 = data.readUInt8(50);
    this.platform.log.debug('Unknown2 (usually 0x04):', unknown2.toString(16));

    if (this.currentState.Active === this.platform.Characteristic.Active.ACTIVE) {
      this.currentState.CurrentHeaterCoolerState = this.calculateCurrentHeaterCoolerState();
      // const state = data.readUInt8(45);
      // switch (state) {
      // case 0x15: // heat
      //   this.currentState.CurrentHeaterCoolerState = this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
      //   break;
      // case 0x06: // cool
      //   this.currentState.CurrentHeaterCoolerState = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
      //   break;
      // default:
      //   this.currentState.CurrentHeaterCoolerState = this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
      //   break;
      // }
    } else {
      this.currentState.CurrentHeaterCoolerState = this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }
    this.platform.log.debug('CurrentHeaterCoolerState:', this.currentState.CurrentHeaterCoolerState);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.currentState.CurrentHeaterCoolerState);

    return true;
  }

  // MARK: - Utility

  checksum(buffer: Buffer): number {
    return buffer.reduce((a, b) => (a + b) & 0xffff, 0);
  }

  numberFromBase10Hex(buffer: Buffer, offset: number) : number {
    const a = buffer.readUInt8(offset + 1); // 01
    const b = buffer.readUInt8(offset); // 95
    return (((a & 0xf)*100)+((b >> 4)*10)+(b & 0xf))/10.0;
  }

  numberToBase10Hex(n: number) : Buffer {
    const a = Math.trunc(n / 10); // 1
    const b = Math.trunc(n % 10); // 9
    const c = n * 10 % 10; // 5
    const buffer = Buffer.alloc(2);
    buffer.writeUInt8(a, 1);
    buffer.writeUInt8((b << 4) + c, 0);
    return buffer;
  }

  pinToBase10Hex(n: number) : Buffer {
    const a = Math.trunc(n / 1000); // 1
    const b = Math.trunc(n / 100 % 10); // 2
    const c = Math.trunc(n / 10 % 10); // 3
    const d = n % 10; // 4
    const buffer = Buffer.alloc(2);
    buffer.writeUInt8((a << 4) + b, 1);
    buffer.writeUInt8((c << 4) + d, 0);
    return buffer;
  }

  targetHeaterCoolerStateToMAMode(targetHeaterCoolerState: number) : number {
    switch (targetHeaterCoolerState) {
      case this.platform.Characteristic.TargetHeaterCoolerState.AUTO: return (MODE_MASK.POWER | MODE_MASK.COOL | MODE_MASK.HEAT | MODE_MASK.DRY | MODE_MASK.AUTO);
      case this.platform.Characteristic.TargetHeaterCoolerState.HEAT: return (MODE_MASK.POWER | MODE_MASK.HEAT);
      case this.platform.Characteristic.TargetHeaterCoolerState.COOL: return (MODE_MASK.POWER | MODE_MASK.COOL);
      default: throw new Error('Invalid TargetHeaterCoolerState!');
    }
  }

  swingModeToMAVaneMode(swingMode: number) : number {
    return swingMode === 1 ? 0x7 : 0x6;
  }

  maVaneModeToSwingMode(vaneMode: number) : number {
    return vaneMode === 0x7 ? 1 : 0;
  }

  rotationSpeedToMAFanMode(rotationSpeed: number) : number {
    return rotationSpeed / 25;
  }

  maFanModeToRotationSpeed(fanMode: number) : number {
    return fanMode * 25;
  }

  calculateCurrentHeaterCoolerState(): number {
    switch (this.currentState.TargetHeaterCoolerState) {
      case this.platform.Characteristic.TargetHeaterCoolerState.HEAT:
        if (this.currentState.CurrentTemperature <= this.currentState.HeatingThresholdTemperature) {
          return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
        } else {
          return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
        }
        break;
      case this.platform.Characteristic.TargetHeaterCoolerState.COOL:
        if (this.currentState.CurrentTemperature >= this.currentState.CoolingThresholdTemperature) {
          return this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
        } else {
          return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
        }
        break;
      case this.platform.Characteristic.TargetHeaterCoolerState.AUTO:
        if (this.currentState.CurrentTemperature < this.currentState.HeatingThresholdTemperature) {
          return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
        } else if (this.currentState.CurrentTemperature > this.currentState.CoolingThresholdTemperature) {
          return this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
        } else {
          return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
        }
        break;

      default:
        return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
    }
  }

  // MARK: - HomeKit API

  /**
   * Handle requests to get the current value of the "Active" characteristic
   */
  handleActiveGet() {
    this.platform.log.debug('Triggered GET Active');

    return this.currentState.Active;
  }

  /**
   * Handle requests to set the current value of the "Active" characteristic
   */
  handleActiveSet(value) {
    this.platform.log.debug('Triggered SET Active');

    if (this.currentState.Active !== value) {
      this.currentState.Active = value;
      this.changedState.Active = true;
    }
  }

  /**
  * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
  */
  handleCurrentHeaterCoolerStateGet() {
    this.platform.log.debug('Triggered GET CurrentHeaterCoolerState');

    return this.currentState.CurrentHeaterCoolerState;
  }

  /**
   * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
   */
  handleTargetHeaterCoolerStateGet() {
    this.platform.log.debug('Triggered GET TargetHeaterCoolerState');

    return this.currentState.TargetHeaterCoolerState;
  }

  /**
   * Handle requests to set the "Target Heating Cooling State" characteristic
   */
  handleTargetHeaterCoolerStateSet(value) {
    this.platform.log.debug('Triggered SET TargetHeaterCoolerState:', value);

    if (this.currentState.TargetHeaterCoolerState !== value) {
      this.currentState.TargetHeaterCoolerState = value;
      this.changedState.TargetHeaterCoolerState = true;
    }
  }

  /**
   * Handle requests to get the current value of the "Current Temperature" characteristic
   */
  handleCurrentTemperatureGet() {
    this.platform.log.debug('Triggered GET CurrentTemperature');

    return this.currentState.CurrentTemperature;
  }

  /**
   * Handle requests to get the current value of the "Cooling Threshold Temperature" characteristic
   */
  handleCoolingThresholdTemperatureGet() {
    this.platform.log.debug('Triggered GET CoolingThresholdTemperature');

    return this.currentState.CoolingThresholdTemperature;
  }

  /**
   * Handle requests to set the "Cooling Threshold Temperature" characteristic
   */
  handleCoolingThresholdTemperatureSet(value) {
    this.platform.log.debug('Triggered SET CoolingThresholdTemperature:', value);

    if (this.currentState.CoolingThresholdTemperature !== value) {
      this.currentState.CoolingThresholdTemperature = value;
      this.changedState.CoolingThresholdTemperature = true;
    }
  }

  /**
   * Handle requests to get the current value of the "Heating Threshold Temperature" characteristic
   */
  handleHeatingThresholdTemperatureGet() {
    this.platform.log.debug('Triggered GET HeatingThresholdTemperature');

    return this.currentState.HeatingThresholdTemperature;
  }

  /**
   * Handle requests to set the "Heating Threshold Temperature" characteristic
   */
  handleHeatingThresholdTemperatureSet(value) {
    this.platform.log.debug('Triggered SET HeatingThresholdTemperature:', value);

    if (this.currentState.HeatingThresholdTemperature !== value) {
      this.currentState.HeatingThresholdTemperature = value;
      this.changedState.HeatingThresholdTemperature = true;
    }
  }

  handleRotationSpeedGet() {
    this.platform.log.debug('Triggered GET RotationSpeed');

    return this.currentState.RotationSpeed;
  }

  handleRotationSpeedSet(value) {
    this.platform.log.debug('Triggered SET RotationSpeed');

    if (this.currentState.RotationSpeed !== value) {
      this.currentState.RotationSpeed = value;
      this.changedState.RotationSpeed = true;
    }
  }

  handleSwingModeGet() {
    this.platform.log.debug('Triggered GET SwingMode');

    return this.currentState.SwingMode;
  }

  handleSwingModeSet(value) {
    this.platform.log.debug('Triggered SET SwingMode');

    if (this.currentState.SwingMode !== value) {
      this.currentState.SwingMode = value;
      this.changedState.SwingMode = true;
    }
  }
}
