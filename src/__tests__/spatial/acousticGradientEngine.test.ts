import {
  clampDecibels,
  calculatePointSPL,
  generateAcousticField,
  decibelsToRgba,
  MIN_ACOUSTIC_DB,
  MAX_ACOUSTIC_DB,
  DEFAULT_AMBIENT_DB,
  type SoundEmitter,
} from "@/lib/spatial/acousticGradientEngine";

describe("acousticGradientEngine dB clamping and boundary guards", () => {
  describe("clampDecibels", () => {
    it("exports standard realistic acoustic limits [20, 110] dB", () => {
      expect(MIN_ACOUSTIC_DB).toBe(20);
      expect(MAX_ACOUSTIC_DB).toBe(110);
      expect(DEFAULT_AMBIENT_DB).toBe(40);
    });

    it("clamps sub-threshold decibel values to MIN_ACOUSTIC_DB (20 dB)", () => {
      expect(clampDecibels(-50)).toBe(20);
      expect(clampDecibels(0)).toBe(20);
      expect(clampDecibels(10)).toBe(20);
      expect(clampDecibels(19.9)).toBe(20);
    });

    it("clamps excessive decibel values to MAX_ACOUSTIC_DB (110 dB)", () => {
      expect(clampDecibels(110.1)).toBe(110);
      expect(clampDecibels(120)).toBe(110);
      expect(clampDecibels(150)).toBe(110);
      expect(clampDecibels(300)).toBe(110);
    });

    it("preserves valid decibel values within [20, 110] range", () => {
      expect(clampDecibels(20)).toBe(20);
      expect(clampDecibels(35.5)).toBe(35.5);
      expect(clampDecibels(68)).toBe(68);
      expect(clampDecibels(85.2)).toBe(85.2);
      expect(clampDecibels(110)).toBe(110);
    });

    it("falls back to DEFAULT_AMBIENT_DB (40 dB) on NaN or non-finite inputs", () => {
      expect(clampDecibels(NaN)).toBe(40);
      expect(clampDecibels(Infinity)).toBe(40);
      expect(clampDecibels(-Infinity)).toBe(40);
      expect(clampDecibels(null as any)).toBe(40);
      expect(clampDecibels(undefined as any)).toBe(40);
    });
  });

  describe("calculatePointSPL", () => {
    it("calculates inverse distance decay within clamped boundaries", () => {
      const splClose = calculatePointSPL(70, 2);
      const splFar = calculatePointSPL(70, 20);
      expect(splClose).toBeGreaterThan(splFar);
      expect(splClose).toBeLessThanOrEqual(MAX_ACOUSTIC_DB);
      expect(splFar).toBeGreaterThanOrEqual(MIN_ACOUSTIC_DB);
    });

    it("clamps extreme source sound level above 110 dB to 110 dB", () => {
      const spl = calculatePointSPL(160, 1);
      expect(spl).toBeLessThanOrEqual(MAX_ACOUSTIC_DB);
    });

    it("clamps extreme decay below 20 dB to 20 dB", () => {
      const spl = calculatePointSPL(30, 1000);
      expect(spl).toBe(MIN_ACOUSTIC_DB);
    });

    it("guards against non-finite or negative distance inputs", () => {
      const splNaN = calculatePointSPL(65, NaN);
      expect(splNaN).toBeGreaterThanOrEqual(MIN_ACOUSTIC_DB);
      expect(splNaN).toBeLessThanOrEqual(MAX_ACOUSTIC_DB);

      const splNeg = calculatePointSPL(65, -10);
      expect(splNeg).toBeGreaterThanOrEqual(MIN_ACOUSTIC_DB);
      expect(splNeg).toBeLessThanOrEqual(MAX_ACOUSTIC_DB);
    });
  });

  describe("generateAcousticField", () => {
    it("generates a grid where all cell values are clamped between [20, 110] dB", () => {
      const emitters: SoundEmitter[] = [
        { id: "e1", name: "Blender", type: "ESPRESSO_BAR", x: 10, y: 10, baseDecibels: 140, isActive: true },
        { id: "e2", name: "Whisper", type: "PHONE_BOOTH", x: 90, y: 90, baseDecibels: -10, isActive: true },
      ];
      const desks = [
        { id: "d1", seatNumber: "Desk 1", x: 10, y: 12 },
        { id: "d2", seatNumber: "Desk 2", x: 90, y: 90 },
      ];

      const result = generateAcousticField(emitters, desks, 10, 10);

      // Verify each grid cell is bounded
      for (const row of result.grid) {
        for (const cell of row) {
          expect(cell).toBeGreaterThanOrEqual(MIN_ACOUSTIC_DB);
          expect(cell).toBeLessThanOrEqual(MAX_ACOUSTIC_DB);
          expect(Number.isFinite(cell)).toBe(true);
        }
      }

      // Verify desk sound predictions are bounded
      for (const desk of result.desks) {
        expect(desk.predictedDecibels).toBeGreaterThanOrEqual(MIN_ACOUSTIC_DB);
        expect(desk.predictedDecibels).toBeLessThanOrEqual(MAX_ACOUSTIC_DB);
        expect(desk.callSuitabilityScore).toBeGreaterThanOrEqual(5);
        expect(desk.callSuitabilityScore).toBeLessThanOrEqual(100);
      }
    });
  });

  describe("decibelsToRgba", () => {
    it("maps clamped decibels to appropriate RGBA colors", () => {
      // <= 38 dB -> Emerald
      const emerald = decibelsToRgba(35);
      expect(emerald[0]).toBe(16); // red
      expect(emerald[1]).toBe(185); // green

      // Below 20 clamped to 20 -> Emerald
      const clampedLow = decibelsToRgba(-20);
      expect(clampedLow[0]).toBe(16);

      // 39 - 46 dB -> Cyan
      const cyan = decibelsToRgba(42);
      expect(cyan[0]).toBe(6);
      expect(cyan[1]).toBe(182);

      // 47 - 56 dB -> Amber
      const amber = decibelsToRgba(50);
      expect(amber[0]).toBe(245);
      expect(amber[1]).toBe(158);

      // > 56 dB -> Crimson
      const crimson = decibelsToRgba(75);
      expect(crimson[0]).toBe(239);
      expect(crimson[1]).toBe(68);

      // Above 110 clamped to 110 -> Crimson
      const clampedHigh = decibelsToRgba(150);
      expect(clampedHigh[0]).toBe(239);

      // NaN fallback to 40 dB -> Cyan
      const fallback = decibelsToRgba(NaN);
      expect(fallback[0]).toBe(6);
      expect(fallback[1]).toBe(182);
    });
  });
});
