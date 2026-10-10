/**
 * SpatialAudioPanner.ts
 * Manages the Web Audio API PannerNodes and GainNodes, calculating 3D coordinates and distance attenuation 
 * based on desk layouts. Sanitizes and clamps gain coefficients to [0.0, 1.0] to prevent audio clipping (#5597).
 */

export interface SpatialPeer {
    id: string;
    audioStream: MediaStream | null;
    pannerNode: PannerNode | null;
    gainNode: GainNode | null;
    position: { x: number; y: number; z: number };
}

export class SpatialAudioPanner {
    private audioContext: AudioContext;
    private peers: Map<string, SpatialPeer>;
    private listener: AudioListener;
    private listenerPosition: { x: number; y: number; z: number };

    public readonly refDistance = 1;
    public readonly maxDistance = 100;
    public readonly rolloffFactor = 1;

    constructor(audioContext: AudioContext) {
        this.audioContext = audioContext;
        this.peers = new Map();
        this.listener = audioContext.listener;
        this.listenerPosition = { x: 0, y: 0, z: 0 };

        // Set default listener position (center of room)
        if (this.listener.positionX) {
            this.listener.positionX.value = 0;
            this.listener.positionY.value = 0;
            this.listener.positionZ.value = 0;
        }
    }

    /**
     * Calculates distance attenuation gain clamped strictly between 0.0 and 1.0.
     * Guards against negative values when distance exceeds max range, and protects against NaN (#5597).
     */
    public calculateDistanceAttenuation(
        sourcePos: { x: number; y: number; z: number },
        listenerPos: { x: number; y: number; z: number } = this.listenerPosition
    ): number {
        const dx = (sourcePos.x ?? 0) - (listenerPos.x ?? 0);
        const dy = (sourcePos.y ?? 0) - (listenerPos.y ?? 0);
        const dz = (sourcePos.z ?? 0) - (listenerPos.z ?? 0);

        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Guard against NaN or identical coordinates
        if (Number.isNaN(distance) || !Number.isFinite(distance) || distance <= 0) {
            return 1.0;
        }

        // Inverse distance attenuation model with safe clamping
        // gain = refDistance / (refDistance + rolloffFactor * (max(distance, refDistance) - refDistance))
        const clampedDistance = Math.min(Math.max(distance, this.refDistance), this.maxDistance);
        let calculatedGain = this.refDistance / (this.refDistance + this.rolloffFactor * (clampedDistance - this.refDistance));

        if (distance > this.maxDistance) {
            // Far distance attenuation dropoff
            calculatedGain = 0.0;
        }

        // Strict clamp to [0.0, 1.0] and NaN check
        if (Number.isNaN(calculatedGain) || !Number.isFinite(calculatedGain)) {
            return 0.0;
        }

        return Math.max(0.0, Math.min(1.0, calculatedGain));
    }

    public addPeer(peerId: string, stream: MediaStream): void {
        if (this.peers.has(peerId)) return;

        const panner = this.audioContext.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = this.refDistance;
        panner.maxDistance = this.maxDistance;
        panner.rolloffFactor = this.rolloffFactor;
        panner.coneInnerAngle = 360;
        panner.coneOuterAngle = 0;
        panner.coneOuterGain = 0;

        const gainNode = this.audioContext.createGain();
        const initialGain = this.calculateDistanceAttenuation({ x: 0, y: 0, z: 0 });
        gainNode.gain.setValueAtTime(initialGain, this.audioContext.currentTime);

        const source = this.audioContext.createMediaStreamSource(stream);
        source.connect(panner);
        panner.connect(gainNode);
        gainNode.connect(this.audioContext.destination);

        this.peers.set(peerId, {
            id: peerId,
            audioStream: stream,
            pannerNode: panner,
            gainNode,
            position: { x: 0, y: 0, z: 0 }
        });
    }

    public updatePeerPosition(peerId: string, x: number, y: number, z: number): void {
        const peer = this.peers.get(peerId);
        if (peer && peer.pannerNode) {
            peer.position = { x, y, z };
            if (peer.pannerNode.positionX) {
                peer.pannerNode.positionX.value = x;
                peer.pannerNode.positionY.value = y;
                peer.pannerNode.positionZ.value = z;
            } else {
                peer.pannerNode.setPosition(x, y, z);
            }

            // Update clamped gain
            if (peer.gainNode) {
                const clampedGain = this.calculateDistanceAttenuation(peer.position);
                peer.gainNode.gain.setValueAtTime(clampedGain, this.audioContext.currentTime);
            }
        }
    }

    public updateListenerPosition(x: number, y: number, z: number, forwardX: number, forwardY: number, forwardZ: number): void {
        this.listenerPosition = { x, y, z };

        if (this.listener.positionX) {
            this.listener.positionX.value = x;
            this.listener.positionY.value = y;
            this.listener.positionZ.value = z;
            this.listener.forwardX.value = forwardX;
            this.listener.forwardY.value = forwardY;
            this.listener.forwardZ.value = forwardZ;
            this.listener.upX.value = 0;
            this.listener.upY.value = 1;
            this.listener.upZ.value = 0;
        } else {
            this.listener.setPosition(x, y, z);
            this.listener.setOrientation(forwardX, forwardY, forwardZ, 0, 1, 0);
        }

        // Recalculate distance attenuation for all active peers
        for (const peer of this.peers.values()) {
            if (peer.gainNode) {
                const clampedGain = this.calculateDistanceAttenuation(peer.position, this.listenerPosition);
                peer.gainNode.gain.setValueAtTime(clampedGain, this.audioContext.currentTime);
            }
        }
    }

    public removePeer(peerId: string): void {
        const peer = this.peers.get(peerId);
        if (peer) {
            peer.pannerNode?.disconnect();
            peer.gainNode?.disconnect();
            this.peers.delete(peerId);
        }
    }

    public destroy(): void {
        for (const peer of this.peers.values()) {
            peer.pannerNode?.disconnect();
            peer.gainNode?.disconnect();
        }
        this.peers.clear();
    }
}
