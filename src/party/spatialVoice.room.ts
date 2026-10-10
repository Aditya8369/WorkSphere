/**
 * spatialVoice.room.ts
 * Real-time low-latency audio transmission room built on PartyKit.
 * Supports binary Opus packet interleaving, spatial vector routing,
 * and JSON coordinate signaling for synchronized 3D spatial audio.
 */

import type * as Party from "partykit/server";

export interface SpatialVector {
  x: number;
  y: number;
  z: number;
}

export interface SpatialUpdate {
  peerId: string;
  x: number;
  y: number;
  z: number;
  timestamp: number;
}

export interface PeerAudioState {
  peerId: string;
  position: SpatialVector;
  lastSequence: number;
  lastTimestamp: number;
  packetsReceived: number;
  packetsLost: number;
}

/**
 * Binary Packet Header Layout (32 Bytes total):
 * Offset  0 -  7: uint64 timestamp
 * Offset  8 - 11: uint32 sequenceNumber
 * Offset 12 - 15: float32 x coordinate
 * Offset 16 - 19: float32 y coordinate
 * Offset 20 - 23: float32 z coordinate
 * Offset 24 - 31: 8-byte peerId prefix or hash
 * Offset 32+: Opus encoded audio frame payload
 */
export const PACKET_HEADER_SIZE = 32;

export default class SpatialVoiceRoom implements Party.Server {
  private peers: Map<string, PeerAudioState> = new Map();
  private positions: Map<string, SpatialUpdate> = new Map();

  constructor(readonly room: Party.Room) {}

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    this.peers.set(conn.id, {
      peerId: conn.id,
      position: { x: 0, y: 0, z: 0 },
      lastSequence: 0,
      lastTimestamp: Date.now(),
      packetsReceived: 0,
      packetsLost: 0,
    });

    // Send initial state of all users to the newly connected peer
    const initialState = Array.from(this.positions.values());
    conn.send(
      JSON.stringify({
        type: "INITIAL_STATE",
        peers: initialState,
      })
    );

    // Notify room members of newly joined voice participant
    this.room.broadcast(
      JSON.stringify({
        type: "voice-peer-joined",
        peerId: conn.id,
      }),
      [conn.id]
    );
  }

  async onDisconnect(conn: Party.Connection) {
    this.peers.delete(conn.id);
    this.positions.delete(conn.id);
    this.room.broadcast(
      JSON.stringify({
        type: "PEER_LEFT",
        peerId: conn.id,
      })
    );
  }

  async onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    // 1. Binary Opus Frame Fast-Path
    if (message instanceof ArrayBuffer) {
      if (message.byteLength < PACKET_HEADER_SIZE) return;

      const view = new DataView(message);
      const timestampHigh = view.getUint32(0, false);
      const timestampLow = view.getUint32(4, false);
      const timestamp = (BigInt(timestampHigh) << 32n) | BigInt(timestampLow);
      const sequenceNumber = view.getUint32(8, false);

      const x = view.getFloat32(12, false);
      const y = view.getFloat32(16, false);
      const z = view.getFloat32(20, false);

      const peerState = this.peers.get(sender.id);
      if (peerState) {
        if (peerState.lastSequence > 0 && sequenceNumber > peerState.lastSequence + 1) {
          peerState.packetsLost += sequenceNumber - peerState.lastSequence - 1;
        }
        peerState.lastSequence = sequenceNumber;
        peerState.lastTimestamp = Number(timestamp);
        peerState.packetsReceived++;
        peerState.position = { x, y, z };
      }

      this.positions.set(sender.id, {
        peerId: sender.id,
        x,
        y,
        z,
        timestamp: Number(timestamp),
      });

      // Blind binary broadcast to other peers
      this.room.broadcast(message, [sender.id]);
      return;
    }

    // 2. JSON Signaling Fast-Path
    try {
      const parsed = JSON.parse(message as string);

      if (parsed.type === "POSITION_UPDATE" || parsed.type === "position-update") {
        const x = parsed.x ?? parsed.position?.x ?? 0;
        const y = parsed.y ?? parsed.position?.y ?? 0;
        const z = parsed.z ?? parsed.position?.z ?? 0;

        const update: SpatialUpdate = {
          peerId: sender.id,
          x,
          y,
          z,
          timestamp: Date.now(),
        };

        this.positions.set(sender.id, update);

        const peer = this.peers.get(sender.id);
        if (peer) {
          peer.position = { x, y, z };
        }

        // Broadcast to all other peers
        this.room.broadcast(
          JSON.stringify({
            type: "PEER_MOVED",
            payload: update,
          }),
          [sender.id]
        );
      }
    } catch (error) {
      console.error("Error processing spatial voice message:", error);
    }
  }
}