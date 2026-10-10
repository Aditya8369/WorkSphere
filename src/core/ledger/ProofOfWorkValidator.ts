/**
 * ProofOfWorkValidator.ts
 * Validates the cryptographic effort required to submit venue data, preventing spam and bot submissions.
 * Ensures the client has expended CPU cycles to find a valid nonce for the Merkle root.
 */

import { createHash } from 'crypto';

export interface PoWSubmission {
    merkleRoot: string;
    nonce: string;
    difficulty: number; // Number of leading zeros required
    timestamp: number;
}

export interface BlockTimingInfo {
    blockHeight?: number;
    timestamp: number;
}

export interface DifficultyAdjustmentConfig {
    targetBlockTimeMs: number; // Expected milliseconds per block/submission
    retargetInterval: number; // Number of blocks per retarget epoch
    minDifficulty: number; // Minimum leading zeros
    maxDifficulty: number; // Maximum leading zeros
    maxAdjustmentFactor: number; // Max dampening factor to prevent oscillation (e.g. 4)
}

export interface DifficultyRecalculationResult {
    newDifficulty: number;
    currentDifficulty: number;
    actualTimeMs: number;
    expectedTimeMs: number;
    adjustmentRatio: number;
    isAdjusted: boolean;
}

export const DEFAULT_DIFFICULTY_CONFIG: DifficultyAdjustmentConfig = {
    targetBlockTimeMs: 10000, // 10 seconds per submission
    retargetInterval: 10,     // Retarget every 10 blocks
    minDifficulty: 1,
    maxDifficulty: 8,
    maxAdjustmentFactor: 4,
};

export class ProofOfWorkValidator {
    private maxAgeMs: number;
    private currentDifficulty: number;
    private blockTimestamps: number[];
    private config: DifficultyAdjustmentConfig;

    constructor(
        maxAgeMs: number = 3600000, // 1 hour default
        initialDifficulty: number = 2,
        config: Partial<DifficultyAdjustmentConfig> = {}
    ) {
        this.maxAgeMs = maxAgeMs;
        this.currentDifficulty = initialDifficulty;
        this.blockTimestamps = [];
        this.config = { ...DEFAULT_DIFFICULTY_CONFIG, ...config };
    }

    private hash(data: string): string {
        return createHash('sha256').update(data).digest('hex');
    }

    /**
     * Validates if the submitted nonce produces a hash with the required number of leading zeros.
     */
    public validate(submission: PoWSubmission): boolean {
        // Check timestamp validity
        const now = Date.now();
        if (now - submission.timestamp > this.maxAgeMs) {
            console.warn('PoW submission expired');
            return false;
        }

        const payload = submission.merkleRoot + submission.nonce + submission.timestamp.toString();
        const hashResult = this.hash(payload);

        // Check leading zeros
        const leadingZerosRegex = new RegExp(`^0{${submission.difficulty}}`);
        if (!leadingZerosRegex.test(hashResult)) {
            console.warn('PoW hash does not meet difficulty requirement');
            return false;
        }

        return true;
    }

    /**
     * Recalculates the adaptive mining difficulty based on observed block/submission timestamps
     * against target block intervals (epoch retargeting algorithm).
     * 
     * If actualTime < expectedTime (mined too fast), difficulty is increased.
     * If actualTime > expectedTime (mined too slow), difficulty is decreased.
     */
    public static recalculateAdaptiveDifficulty(
        currentDifficulty: number,
        recentTimings: (number | BlockTimingInfo)[],
        configOverrides: Partial<DifficultyAdjustmentConfig> = {}
    ): DifficultyRecalculationResult {
        const config: DifficultyAdjustmentConfig = {
            ...DEFAULT_DIFFICULTY_CONFIG,
            ...configOverrides,
        };

        if (recentTimings.length < 2) {
            return {
                newDifficulty: currentDifficulty,
                currentDifficulty,
                actualTimeMs: 0,
                expectedTimeMs: config.targetBlockTimeMs,
                adjustmentRatio: 1.0,
                isAdjusted: false,
            };
        }

        // Extract and sort numeric timestamps
        const timestamps = recentTimings
            .map(t => (typeof t === 'number' ? t : t.timestamp))
            .filter(t => Number.isFinite(t) && t > 0)
            .sort((a, b) => a - b);

        if (timestamps.length < 2) {
            return {
                newDifficulty: currentDifficulty,
                currentDifficulty,
                actualTimeMs: 0,
                expectedTimeMs: config.targetBlockTimeMs,
                adjustmentRatio: 1.0,
                isAdjusted: false,
            };
        }

        const firstTimestamp = timestamps[0];
        const lastTimestamp = timestamps[timestamps.length - 1];
        const actualTimeMs = Math.max(1, lastTimestamp - firstTimestamp);

        const intervalsCount = timestamps.length - 1;
        const expectedTimeMs = intervalsCount * config.targetBlockTimeMs;

        const rawRatio = actualTimeMs / expectedTimeMs;

        // Apply dampening bounds to prevent extreme fluctuations
        const maxFactor = Math.max(1.01, config.maxAdjustmentFactor);
        const minFactor = 1 / maxFactor;
        const adjustmentRatio = Math.max(minFactor, Math.min(maxFactor, rawRatio));

        // Adjust difficulty in inverse logarithmic steps:
        // actualTime < expectedTime => ratio < 1 => -log2(ratio) > 0 (difficulty increases)
        // actualTime > expectedTime => ratio > 1 => -log2(ratio) < 0 (difficulty decreases)
        const difficultyDelta = Math.round(-Math.log2(adjustmentRatio));
        const unclampedDifficulty = currentDifficulty + difficultyDelta;

        const newDifficulty = Math.max(
            config.minDifficulty,
            Math.min(config.maxDifficulty, unclampedDifficulty)
        );

        return {
            newDifficulty,
            currentDifficulty,
            actualTimeMs,
            expectedTimeMs,
            adjustmentRatio,
            isAdjusted: newDifficulty !== currentDifficulty,
        };
    }

    /**
     * Records a new block timestamp and returns the active adaptive difficulty.
     */
    public recordBlock(timestamp: number = Date.now()): number {
        this.blockTimestamps.push(timestamp);

        if (this.blockTimestamps.length >= this.config.retargetInterval) {
            const result = ProofOfWorkValidator.recalculateAdaptiveDifficulty(
                this.currentDifficulty,
                this.blockTimestamps,
                this.config
            );
            this.currentDifficulty = result.newDifficulty;
            // Keep the last timestamp to anchor the next epoch
            this.blockTimestamps = [this.blockTimestamps[this.blockTimestamps.length - 1]];
        }

        return this.currentDifficulty;
    }

    public getDifficulty(): number {
        return this.currentDifficulty;
    }

    public setDifficulty(difficulty: number): void {
        this.currentDifficulty = Math.max(
            this.config.minDifficulty,
            Math.min(this.config.maxDifficulty, difficulty)
        );
    }

    /**
     * Computes the 64-character hex target representation corresponding to a difficulty level.
     */
    public static calculateTargetHash(difficulty: number): string {
        const clampedDiff = Math.max(0, Math.min(64, difficulty));
        return '0'.repeat(clampedDiff) + 'f'.repeat(64 - clampedDiff);
    }

    /**
     * Checks if a hash satisfies the target difficulty.
     */
    public static meetsDifficultyTarget(hash: string, difficulty: number): boolean {
        if (!hash || typeof hash !== 'string') return false;
        const targetPrefix = '0'.repeat(Math.max(0, difficulty));
        return hash.startsWith(targetPrefix);
    }

    /**
     * Calculates the dynamic difficulty based on network load or spam rate.
     */
    public static calculateDifficulty(baseDifficulty: number, spamMultiplier: number): number {
        return Math.min(Math.max(baseDifficulty + Math.floor(spamMultiplier), 1), 8);
    }
}
