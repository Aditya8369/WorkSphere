import {
  DEFAULT_RRF_K,
  validateAndClampRrfK,
  calculateRrfScore,
} from "@/lib/search/hybridVenueSearch";

describe("Reciprocal Rank Fusion (RRF) Formula & Boundary Guards (#5603)", () => {
  describe("validateAndClampRrfK", () => {
    it("returns default k = 60 when k is undefined, null, NaN, or non-finite", () => {
      expect(validateAndClampRrfK()).toBe(DEFAULT_RRF_K);
      expect(validateAndClampRrfK(undefined)).toBe(60);
      expect(validateAndClampRrfK(NaN)).toBe(60);
      expect(validateAndClampRrfK(Infinity)).toBe(60);
      expect(validateAndClampRrfK(-Infinity)).toBe(60);
    });

    it("clamps zero and negative values of k to minimum 1", () => {
      expect(validateAndClampRrfK(0)).toBe(1);
      expect(validateAndClampRrfK(-1)).toBe(1);
      expect(validateAndClampRrfK(-60)).toBe(1);
      expect(validateAndClampRrfK(-999)).toBe(1);
    });

    it("floors positive non-integer values of k and respects valid integer k >= 1", () => {
      expect(validateAndClampRrfK(1)).toBe(1);
      expect(validateAndClampRrfK(20)).toBe(20);
      expect(validateAndClampRrfK(60)).toBe(60);
      expect(validateAndClampRrfK(100)).toBe(100);
      expect(validateAndClampRrfK(20.8)).toBe(20);
      expect(validateAndClampRrfK(0.75)).toBe(1);
    });
  });

  describe("calculateRrfScore", () => {
    it("computes exact standard RRF score: weight / (k + rank)", () => {
      // rank 1 with k=60, weight=1 => 1 / 61
      expect(calculateRrfScore(1, 60, 1)).toBeCloseTo(1 / 61, 6);

      // rank 2 with k=60, weight=1 => 1 / 62
      expect(calculateRrfScore(2, 60, 1)).toBeCloseTo(1 / 62, 6);

      // rank 1 with k=20, weight=0.5 => 0.5 / 21
      expect(calculateRrfScore(1, 20, 0.5)).toBeCloseTo(0.5 / 21, 6);
    });

    it("guards against division by zero when k is 0 or negative by clamping k to 1", () => {
      // If k=0 was permitted, k + rank could be 0 or small
      // Clamping k to 1 ensures finite valid score
      const scoreWithZeroK = calculateRrfScore(1, 0, 1);
      expect(Number.isFinite(scoreWithZeroK)).toBe(true);
      expect(scoreWithZeroK).toBeCloseTo(1 / (1 + 1), 6);

      const scoreWithNegativeK = calculateRrfScore(1, -10, 1);
      expect(Number.isFinite(scoreWithNegativeK)).toBe(true);
      expect(scoreWithNegativeK).toBeCloseTo(1 / (1 + 1), 6);
    });

    it("guards against zero or negative ranks by returning 0", () => {
      expect(calculateRrfScore(0, 60, 1)).toBe(0);
      expect(calculateRrfScore(-1, 60, 1)).toBe(0);
      expect(calculateRrfScore(-100, 60, 1)).toBe(0);
    });

    it("guards against null, undefined, NaN, and non-finite ranks by returning 0", () => {
      expect(calculateRrfScore(null, 60, 1)).toBe(0);
      expect(calculateRrfScore(undefined, 60, 1)).toBe(0);
      expect(calculateRrfScore(NaN, 60, 1)).toBe(0);
      expect(calculateRrfScore(Infinity, 60, 1)).toBe(0);
    });

    it("floors non-integer ranks properly", () => {
      // Rank 1.9 should be treated as rank 1 (floored)
      expect(calculateRrfScore(1.9, 60, 1)).toBe(calculateRrfScore(1, 60, 1));
      // Rank 2.5 should be treated as rank 2
      expect(calculateRrfScore(2.5, 60, 1)).toBe(calculateRrfScore(2, 60, 1));
      // Rank 0.8 floors to 0 which is < 1, so returns 0
      expect(calculateRrfScore(0.8, 60, 1)).toBe(0);
    });

    it("guards against negative or non-finite weights", () => {
      expect(calculateRrfScore(1, 60, -0.5)).toBe(0);
      expect(calculateRrfScore(1, 60, NaN)).toBe(0);
      expect(calculateRrfScore(1, 60, Infinity)).toBe(0);
    });
  });

  describe("Typo Tolerance Trigram Fuzzy Matching Fallback (#5771)", () => {
    let prismaMock: any;

    beforeEach(async () => {
      const { prisma } = await import("@/lib/prisma");
      prismaMock = prisma;
      jest.clearAllMocks();
    });

    it("triggers Postgres SIMILARITY(name, $query) query when standard ts_query yields 0 rows", async () => {
      const { searchVenuesWithRrf } = await import("@/lib/search/hybridVenueSearch");

      // First query (standard BM25/vector RRF) returns 0 candidates for typo "startbuks"
      // Second query (pg_trgm SIMILARITY) returns closest match "Starbucks"
      (prismaMock.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([]) // 0 exact/BM25 matches
        .mockResolvedValueOnce([
          {
            id: "venue-starbucks-1",
            name: "Starbucks Coffee",
            similarity: 0.72,
            score: 0.72,
            needs_embedding: false,
            search_document: "Starbucks Coffee cafe 123 Main St",
          },
        ]);

      const results = await searchVenuesWithRrf("startbuks");

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("venue-starbucks-1");
      expect(results[0].fuzzyMatched).toBe(true);
      expect(results[0].matchedName).toBe("Starbucks Coffee");
      expect(results[0].suggestedQuery).toBe("Starbucks Coffee");
      expect(results.fuzzyMatched).toBe(true);
      expect(results.suggestedQuery).toBe("Starbucks Coffee");

      // Verify that $queryRaw was called twice: standard search first, then SIMILARITY fallback
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);

      // Verify the second query utilizes Postgres SIMILARITY
      const fuzzyQuerySql = (prismaMock.$queryRaw as jest.Mock).mock.calls[1][0];
      const sqlString = fuzzyQuerySql.strings.join(" ");
      expect(sqlString).toContain("SIMILARITY(v.\"name\"");
      expect(sqlString).toContain("WHERE SIMILARITY(v.\"name\"");
      expect(sqlString).toContain("ORDER BY SIMILARITY(v.\"name\"");
    });

    it("does not trigger fuzzy matching fallback when standard search finds matches", async () => {
      const { searchVenuesWithRrf } = await import("@/lib/search/hybridVenueSearch");

      // First query succeeds with exact match
      (prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([
        {
          id: "venue-blue-bottle",
          score: 0.032,
          needs_embedding: false,
          search_document: "Blue Bottle Coffee",
        },
      ]);

      const results = await searchVenuesWithRrf("blue bottle");

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("venue-blue-bottle");
      expect(results.fuzzyMatched).toBe(false);
      expect(results.suggestedQuery).toBeUndefined();

      // Only 1 query executed
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("returns empty list with fuzzyMatched: false when both exact and fuzzy queries return 0 rows", async () => {
      const { searchVenuesWithRrf } = await import("@/lib/search/hybridVenueSearch");

      (prismaMock.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([]) // 0 standard matches
        .mockResolvedValueOnce([]); // 0 fuzzy matches

      const results = await searchVenuesWithRrf("xyzcompletelynonexistent");

      expect(results).toHaveLength(0);
      expect(results.fuzzyMatched).toBe(false);
      expect(results.suggestedQuery).toBeUndefined();
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it("gracefully falls back to in-memory fuzzy search if Postgres pg_trgm query throws", async () => {
      const { searchVenuesWithRrf } = await import("@/lib/search/hybridVenueSearch");

      (prismaMock.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([]) // 0 standard matches
        .mockRejectedValueOnce(new Error("function similarity(text, text) does not exist")); // pg_trgm missing

      (prismaMock.venue.findMany as jest.Mock).mockResolvedValueOnce([
        {
          id: "venue-wework",
          name: "WeWork Space",
          address: "100 Market St",
          description: "Coworking office",
        },
      ]);

      const results = await searchVenuesWithRrf("wewrok");

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("venue-wework");
      expect(results.fuzzyMatched).toBe(true);
      expect(results.suggestedQuery).toBe("WeWork Space");
    });

    it("skips fuzzy matching when enableFuzzyFallback is false", async () => {
      const { searchVenuesWithRrf } = await import("@/lib/search/hybridVenueSearch");

      (prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      const results = await searchVenuesWithRrf("startbuks", {
        enableFuzzyFallback: false,
      });

      expect(results).toHaveLength(0);
      expect(results.fuzzyMatched).toBe(false);
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });
});
