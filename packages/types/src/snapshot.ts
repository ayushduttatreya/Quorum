export interface SnapshotSlice {
  protocol: string;
  version: number;
  data: Uint8Array;
  checksum: string;
}

export interface Snapshot {
  seq: number;
  term: number;
  epoch: number;
  protocolVersions: Record<string, number>;
  slices: SnapshotSlice[];
  checksum: string;
  createdAt: number;
}

export interface SnapshotMetadata {
  seq: number;
  r2Key: string;
  checksum: string;
  protocolVersions: Record<string, number>;
  createdAt: number;
}
