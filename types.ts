
export type Scenario = 'normal' | 'spoof_photo' | 'spoof_video';

export type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

export interface Point {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface FaceMeshResult {
    all: Point[];
    specific: Point[];
    flat: number[];
}

export interface SensorData {
  timestamp: number;
  accel: { x: number | null; y: number | null; z: number | null } | null;
  gyro: { alpha: number | null; beta: number | null; gamma: number | null } | null;
}

export interface FrameData {
  timestamp: number;
  faceMesh: number[] | null;
  sensors: {
    accel: { x: number | null; y: number | null; z: number | null } | null;
    gyro: { alpha: number | null; beta: number | null; gamma: number | null } | null;
  };
  opticalFlow: number[];
}
