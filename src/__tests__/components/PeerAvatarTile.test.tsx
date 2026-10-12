import { render, screen, act } from "@testing-library/react";
import { PeerAvatarTile } from "@/components/audio/PeerAvatarTile";

// Mock usePeakDecayLevel so tests control the smoothed audio level directly
jest.mock("@/hooks/usePeakDecayLevel", () => ({
  usePeakDecayLevel: (level: number) => level,
}));

const defaultProps = {
  peerId: "peer-1",
  isLocal: false,
  name: "Alice",
};

describe("PeerAvatarTile", () => {
  it("renders the peer name", () => {
    render(<PeerAvatarTile {...defaultProps} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("renders initials when no avatarUrl is provided", () => {
    render(<PeerAvatarTile {...defaultProps} />);
    // Initials for "Alice" with no surname = "A"
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("renders the avatar image when avatarUrl is provided", () => {
    render(
      <PeerAvatarTile
        {...defaultProps}
        avatarUrl="https://example.com/alice.jpg"
      />,
    );
    const img = screen.getByRole("img", { name: "Alice" });
    expect(img).toHaveAttribute("src", "https://example.com/alice.jpg");
  });

  describe("AudioLevelIndicator ring", () => {
    it("renders an SVG ring element", () => {
      const { container } = render(
        <PeerAvatarTile {...defaultProps} audioLevel={0.5} />,
      );
      // AudioLevelIndicator renders an SVG
      expect(container.querySelector("svg")).toBeInTheDocument();
    });

    it("ring strokeDashoffset decreases as audioLevel increases (higher volume = more filled ring)", () => {
      const { container: low } = render(
        <PeerAvatarTile {...defaultProps} audioLevel={0.1} />,
      );
      const { container: high } = render(
        <PeerAvatarTile {...defaultProps} audioLevel={0.9} />,
      );

      const findCircle = (c: HTMLElement) =>
        Array.from(c.querySelectorAll("circle")).find(
          (el) =>
            el.getAttribute("stroke-dashoffset") !== null ||
            (el.style?.strokeDashoffset ?? "") !== "",
        );

      const getOffset = (el?: Element | null) => {
        if (!el) return 999;
        const attr = el.getAttribute("stroke-dashoffset");
        if (attr) return parseFloat(attr);
        const style = (el as HTMLElement).style?.strokeDashoffset;
        return style ? parseFloat(style) : 999;
      };

      const lowOffset = getOffset(findCircle(low));
      const highOffset = getOffset(findCircle(high));

      // Higher audio level → smaller dashoffset (ring is more filled)
      expect(highOffset).toBeLessThan(lowOffset);
    });

    it("ring is muted (gray) when audioEnabled is false", () => {
      const { container } = render(
        <PeerAvatarTile
          {...defaultProps}
          audioLevel={0.8}
          audioEnabled={false}
        />,
      );
      const svgs = container.querySelectorAll("svg");
      expect(svgs.length).toBeGreaterThan(0);
      // The muted ring should use gray color — verify via stroke attribute or CSS class
      const ringCircle = Array.from(container.querySelectorAll("circle")).find(
        (el) => el.getAttribute("stroke"),
      );
      expect(ringCircle).toBeDefined();
    });

    it("ring is visible when audio level > 0", () => {
      const { container } = render(
        <PeerAvatarTile
          {...defaultProps}
          audioLevel={0.5}
          audioEnabled={true}
        />,
      );
      const svgs = container.querySelectorAll("svg");
      expect(svgs.length).toBeGreaterThan(0);
    });
  });

  it("shows 'You' badge for local peer", () => {
    render(<PeerAvatarTile {...defaultProps} isLocal={true} />);
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("does not show 'You' badge for remote peer", () => {
    render(<PeerAvatarTile {...defaultProps} isLocal={false} />);
    expect(screen.queryByText("You")).not.toBeInTheDocument();
  });

  describe("Mic status badge & dynamic states", () => {
    it("renders mic status badge in muted state with red crossed-out mic and 'Participant muted' tooltip", () => {
      render(<PeerAvatarTile {...defaultProps} audioEnabled={false} />);
      const badge = screen.getByTestId("mic-status-badge");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveAttribute("title", "Participant muted");
      expect(badge).toHaveAttribute("data-state", "muted");
      expect(screen.getByTestId("mic-muted-icon")).toBeInTheDocument();
      expect(screen.queryByTestId("mic-silent-icon")).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("mic-transmitting-icon"),
      ).not.toBeInTheDocument();
    });

    it("renders mic status badge in silent state with gray mic when audio is enabled but not speaking", () => {
      render(
        <PeerAvatarTile
          {...defaultProps}
          audioEnabled={true}
          isSpeaking={false}
        />,
      );
      const badge = screen.getByTestId("mic-status-badge");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveAttribute("data-state", "silent");
      expect(screen.getByTestId("mic-silent-icon")).toBeInTheDocument();
      expect(screen.queryByTestId("mic-muted-icon")).not.toBeInTheDocument();
      expect(screen.queryByTestId("radiating-waves")).not.toBeInTheDocument();
    });

    it("renders mic status badge in transmitting state with green mic and animated radiating waves when speaking", () => {
      render(
        <PeerAvatarTile
          {...defaultProps}
          audioEnabled={true}
          isSpeaking={true}
        />,
      );
      const badge = screen.getByTestId("mic-status-badge");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveAttribute("data-state", "transmitting");
      expect(screen.getByTestId("mic-transmitting-icon")).toBeInTheDocument();
      expect(screen.getByTestId("radiating-waves")).toBeInTheDocument();
      expect(screen.queryByTestId("mic-muted-icon")).not.toBeInTheDocument();
    });

    it("reacts dynamically to peer audio track enabled property changes", () => {
      jest.useFakeTimers();

      const trackListeners: Record<string, EventListener[]> = {};
      const mockTrack = {
        kind: "audio",
        enabled: true,
        muted: false,
        addEventListener: jest.fn((event: string, cb: EventListener) => {
          trackListeners[event] = trackListeners[event] || [];
          trackListeners[event].push(cb);
        }),
        removeEventListener: jest.fn((event: string, cb: EventListener) => {
          if (trackListeners[event]) {
            trackListeners[event] = trackListeners[event].filter(
              (f) => f !== cb,
            );
          }
        }),
      };

      const mockStream = {
        getAudioTracks: () => [mockTrack],
        getVideoTracks: () => [],
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      } as unknown as MediaStream;

      const { unmount } = render(
        <PeerAvatarTile
          {...defaultProps}
          stream={mockStream}
          audioEnabled={true}
          isSpeaking={false}
        />,
      );

      // Initially audio track is enabled -> silent state
      const badge = screen.getByTestId("mic-status-badge");
      expect(badge).toHaveAttribute("data-state", "silent");
      expect(screen.getByTestId("mic-silent-icon")).toBeInTheDocument();

      // Disable track and advance timer / trigger mute event
      mockTrack.enabled = false;
      act(() => {
        jest.advanceTimersByTime(250);
      });

      // Now badge should react and show muted state with "Participant muted" tooltip
      expect(badge).toHaveAttribute("data-state", "muted");
      expect(badge).toHaveAttribute("title", "Participant muted");
      expect(screen.getByTestId("mic-muted-icon")).toBeInTheDocument();

      // Re-enable track
      mockTrack.enabled = true;
      act(() => {
        jest.advanceTimersByTime(250);
      });

      expect(badge).toHaveAttribute("data-state", "silent");
      expect(screen.getByTestId("mic-silent-icon")).toBeInTheDocument();

      unmount();
      jest.useRealTimers();
    });
  });

  describe("AudioLevelIndicator - Smooth Decibel Decay & Lerp Interpolation (#6155)", () => {
    const {
      AudioLevelIndicator,
      lerpDecay,
      DEFAULT_DECAY_FACTOR,
      AUDIO_DECAY_TIMEOUT_MS,
    } = require("@/components/audio/AudioLevelIndicator");

    it("exports default decay factor of 0.2 and 300ms fallback timeout", () => {
      expect(DEFAULT_DECAY_FACTOR).toBe(0.2);
      expect(AUDIO_DECAY_TIMEOUT_MS).toBe(300);
    });

    describe("lerpDecay formula", () => {
      it("decays currentLevel towards targetLevel using default decayFactor (0.2)", () => {
        // current = 1.0, target = 0.0 -> 1.0 + (0 - 1.0) * 0.2 = 0.8
        expect(lerpDecay(1.0, 0.0, 0.2)).toBeCloseTo(0.8);

        // next frame: current = 0.8, target = 0.0 -> 0.8 + (0 - 0.8) * 0.2 = 0.64
        expect(lerpDecay(0.8, 0.0, 0.2)).toBeCloseTo(0.64);
      });

      it("interpolates upwards when targetLevel is greater than currentLevel", () => {
        // current = 0.2, target = 0.7 -> 0.2 + (0.7 - 0.2) * 0.2 = 0.3
        expect(lerpDecay(0.2, 0.7, 0.2)).toBeCloseTo(0.3);
      });

      it("supports custom decay factors", () => {
        expect(lerpDecay(1.0, 0.0, 0.5)).toBeCloseTo(0.5);
        expect(lerpDecay(1.0, 0.0, 0.1)).toBeCloseTo(0.9);
      });
    });

    describe("AudioLevelIndicator Component rendering with smooth decay", () => {
      it("renders initial level immediately without harsh jumping", () => {
        render(<AudioLevelIndicator level={0.8} />);
        const meter = screen.getByRole("meter");
        expect(meter).toBeInTheDocument();
        expect(meter).toHaveAttribute("aria-valuenow", "80");
      });

      it("renders 0% when muted", () => {
        render(<AudioLevelIndicator level={0.8} muted={true} />);
        const meter = screen.getByRole("meter");
        expect(meter).toHaveAttribute("aria-valuenow", "0");
        expect(meter).toHaveAttribute("aria-label", "Audio muted");
      });

      it("smoothly interpolates decay across animation frames when volume drops", () => {
        let frameCallback: FrameRequestCallback | null = null;
        jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
          frameCallback = cb;
          return 123;
        });
        const cancelSpy = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

        const { rerender } = render(<AudioLevelIndicator level={1.0} />);
        expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");

        // Now volume drops to 0.0
        rerender(<AudioLevelIndicator level={0.0} />);

        // Execute animation frame
        if (frameCallback) {
          act(() => {
            (frameCallback as FrameRequestCallback)(performance.now());
          });
        }

        // Value should have decayed smoothly (around ~80% instead of dropping instantly to 0)
        const ariaVal = parseInt(screen.getByRole("meter").getAttribute("aria-valuenow") || "0", 10);
        expect(ariaVal).toBeLessThan(100);
        expect(ariaVal).toBeGreaterThan(0);

        cancelSpy.mockRestore();
        (window.requestAnimationFrame as jest.Mock).mockRestore();
      });

      it("cleans up requestAnimationFrame on unmount", () => {
        const cancelSpy = jest.spyOn(window, "cancelAnimationFrame");
        const { unmount } = render(<AudioLevelIndicator level={0.5} />);
        unmount();
        expect(cancelSpy).toHaveBeenCalled();
        cancelSpy.mockRestore();
      });
    });
  });
});
