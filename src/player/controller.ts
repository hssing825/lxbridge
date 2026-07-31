// Songloft-LX 插件 — 播放控制器
// 通过MIoT桥接控制小爱音响播放

/// <reference types="@songloft/plugin-sdk" />

import { MIoTBridge } from '../bridge/miot';
import { ConfigManager } from '../config/manager';
import type { PluginState, MIoTDevice } from '../lxserver/types';

export class PlayerController {
  private miotBridge: MIoTBridge;
  private configManager: ConfigManager;

  // 当前状态
  private currentDevice: MIoTDevice | null = null;
  private isPlaying: boolean = false;
  private currentVolume: number = 50;
  private currentPlayMode: string = 'order';

  constructor(miotBridge: MIoTBridge, configManager: ConfigManager) {
    this.miotBridge = miotBridge;
    this.configManager = configManager;
  }

  // ===== 初始化 =====

  async init(): Promise<void> {
    const saved = await this.configManager.getSelectedDevice();
    if (saved) {
      const devices = await this.miotBridge.getDevices();
      const device = devices.find(
        d => d.account_id === saved.accountId && d.device_id === saved.deviceId
      );
      if (device) {
        this.currentDevice = device;
        await this.refreshStatus();
      }
    }
  }

  // ===== 设备管理 =====

  async getDevices(): Promise<MIoTDevice[]> {
    return await this.miotBridge.getDevices();
  }

  getCurrentDevice(): MIoTDevice | null {
    return this.currentDevice;
  }

  async selectDevice(accountId: string, deviceId: string): Promise<boolean> {
    const devices = await this.miotBridge.getDevices();
    const device = devices.find(
      d => d.account_id === accountId && d.device_id === deviceId
    );
    if (device) {
      this.currentDevice = device;
      await this.configManager.saveSelectedDevice(accountId, deviceId);
      await this.refreshStatus();
      songloft.log.info('[Player] Selected device: ' + device.device_name);
      return true;
    }
    return false;
  }

  // ===== 播放控制 =====

  private requireDevice(): { accountId: string; deviceId: string } {
    if (!this.currentDevice) {
      throw new Error('未选择音响设备');
    }
    return {
      accountId: this.currentDevice.account_id,
      deviceId: this.currentDevice.device_id,
    };
  }

  async play(url: string, title?: string, artist?: string, accountId?: string, deviceId?: string): Promise<boolean> {
    // 如果提供了设备参数，使用它们；否则使用当前选中的设备
    if (accountId && deviceId) {
      const result = await this.miotBridge.playSong(accountId, deviceId, url);
      if (result) {
        this.isPlaying = true;
      }
      return result;
    } else {
      const { accountId: aid, deviceId: did } = this.requireDevice();
      const result = await this.miotBridge.playSong(aid, did, url);
      if (result) {
        this.isPlaying = true;
      }
      return result;
    }
  }

  async pause(): Promise<boolean> {
    const { accountId, deviceId } = this.requireDevice();
    const result = await this.miotBridge.controlPlayback({ action: 'toggle', account_id: accountId, device_id: deviceId });
    if (result) {
      this.isPlaying = false;
    }
    return result;
  }

  async resume(): Promise<boolean> {
    // MIoT 的播放控制中，toggle action 对已暂停的设备执行 resume
    const { accountId, deviceId } = this.requireDevice();
    const result = await this.miotBridge.controlPlayback({
      action: 'toggle',
      account_id: accountId,
      device_id: deviceId,
    });
    if (result) {
      this.isPlaying = true;
    }
    return result;
  }

  async next(): Promise<boolean> {
    const { accountId, deviceId } = this.requireDevice();
    return await this.miotBridge.controlPlayback({ action: 'next', account_id: accountId, device_id: deviceId });
  }

  async prev(): Promise<boolean> {
    const { accountId, deviceId } = this.requireDevice();
    return await this.miotBridge.controlPlayback({ action: 'previous', account_id: accountId, device_id: deviceId });
  }

  async setVolume(volume: number): Promise<boolean> {
    const { accountId, deviceId } = this.requireDevice();
    const result = await this.miotBridge.setVolume(accountId, deviceId, volume);
    if (result) {
      this.currentVolume = volume;
    }
    return result;
  }

  async setPlayMode(mode: string): Promise<boolean> {
    const { accountId, deviceId } = this.requireDevice();
    const result = await this.miotBridge.setPlayMode(accountId, deviceId, mode);
    if (result) {
      this.currentPlayMode = mode;
    }
    return result;
  }

  async stop(): Promise<boolean> {
    const { accountId, deviceId } = this.requireDevice();
    const result = await this.miotBridge.controlPlayback({
      action: 'stop',
      account_id: accountId,
      device_id: deviceId,
    });
    if (result) {
      this.isPlaying = false;
    }
    return result;
  }

  // ===== 状态 =====

  async refreshStatus(): Promise<void> {
    if (!this.currentDevice) return;
    try {
      const status = await this.miotBridge.getPlayerStatus(
        this.currentDevice.account_id,
        this.currentDevice.device_id
      );
      if (status) {
        this.isPlaying = status.state === 'playing';
        this.currentVolume = status.volume;
        this.currentPlayMode = status.playMode;
      }
    } catch {
      // 静默失败
    }
  }

  async getState(): Promise<PluginState['playerStatus']> {
    await this.refreshStatus();
    return {
      state: this.isPlaying ? 'playing' : (this.currentDevice ? 'paused' : 'idle'),
      position: 0,
      duration: 0,
      volume: this.currentVolume,
      playMode: this.currentPlayMode,
    };
  }
}
