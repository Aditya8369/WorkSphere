"use client";

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from "react";
import {
  Volume2,
  VolumeX,
  Radio,
  Sliders,
  Move,
  Users,
  Headphones,
  Sparkles,
  Disc,
} from "lucide-react";
import {
  createGeodesicRadarDomeScene,
  projectStageTo3DGround,
  computeDomeSurfaceHeight,
  isWebGLAvailable,
  type GeodesicRadarDomeSceneController,
} from "./geodesicRadarDomeScene";
import {
  ProximityBoundaryZoneConfig,
  PROXIMITY_ZONE_PRESETS,
  ProximityZonePresetId,
  FadeOutCurve,
  calculateProximityFadeGain,
  getProximityZoneTier,
  sanitizeProximityZoneConfig,
} from "@/core/audio/ProximityBoundaryZone";

export * from "@/core/audio/ProximityBoundaryZone";

export {
  createGeodesicRadarDomeScene,
  projectStageTo3DGround,
  computeDomeSurfaceHeight,
  isWebGLAvailable,
};

export interface StagePosition {
  x: number;
  y: number;
  z?: number;
}

export interface PeerAvatar {
  id: string;
  name: string;
  position: StagePosition;
  audioStream?: MediaStream | null;
  color?: string;
  avatarUrl?: string;
  isMuted?: boolean;
}

export interface LocalUserAvatar {
  id?: string;
  name?: string;
  position: StagePosition;
  avatarUrl?: string;
}

export interface SpatialAudioStageProps {
  roomId?: string;
  localUser?: LocalUserAvatar;
  initialPeers?: PeerAvatar[];
  peers?: PeerAvatar[];
  peerStreams?: Record<string, MediaStream> | Map<string, MediaStream>;
  audioContext?: AudioContext;
  rolloffFactor?: number;
  refDistance?: number;
  maxDistance?: number;
  stageWidth?: number;
  stageHeight?: number;
  coordinateScale?: number;
  coordinateMapping?: "xz" | "xy";
  onPeerMove?: (peerId: string, position: StagePosition) => void;
  onLocalMove?: (position: StagePosition) => void;
  className?: string;
  proximityBoundaryZone?: Partial<ProximityBoundaryZoneConfig>;
  onProximityBoundaryZoneChange?: (zone: ProximityBoundaryZoneConfig) => void;
  showBoundaryRings?: boolean;
}

interface PeerAudioChain {
  peerId: string;
  source: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
  panner: PannerNode;
  gain: GainNode;
  stream: MediaStream;
}

/**
 * Computes normalized RMS/average audio volume level (0.0 to 1.0) from an AnalyserNode.
 */
export function getPeerAudioLevel(analyser?: AnalyserNode): number {
  if (!analyser) return 0;
  try {
    const dataArray = new Uint8Array(analyser.frequencyBinCount || 32);
    analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    return sum / (dataArray.length * 255);
  } catch {
    return 0;
  }
}

/**
 * Converts 2D/3D stage coordinates to Web Audio 3D coordinates.
 * By default on a 2D floor (xz plane), X is lateral, Z is depth/distance, and Y is height (0).
 */
export function stageToAudioCoordinates(
  pos: StagePosition,
  scale: number = 1.0,
  mapping: "xz" | "xy" = "xz",
): { x: number; y: number; z: number } {
  if (pos.z !== undefined) {
    return {
      x: pos.x * scale,
      y: pos.y * scale,
      z: pos.z * scale,
    };
  }

  if (mapping === "xy") {
    return {
      x: pos.x * scale,
      y: pos.y * scale,
      z: 0,
    };
  }

  return {
    x: pos.x * scale,
    y: 0,
    z: pos.y * scale,
  };
}

/**
 * Updates a PannerNode's 3D coordinates safely across Web Audio implementations.
 */
export function updatePannerCoordinates(
  panner: PannerNode,
  x: number,
  y: number,
  z: number,
): void {
  if (
    typeof panner.positionX === "object" &&
    panner.positionX !== null &&
    "value" in panner.positionX
  ) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else if ("setPosition" in panner) {
    (
      panner as unknown as {
        setPosition: (x: number, y: number, z: number) => void;
      }
    ).setPosition(x, y, z);
  }
}

/**
 * Updates an AudioListener's 3D coordinates safely.
 */
export function updateListenerCoordinates(
  listener: AudioListener,
  x: number,
  y: number,
  z: number,
): void {
  if (
    typeof listener.positionX === "object" &&
    listener.positionX !== null &&
    "value" in listener.positionX
  ) {
    listener.positionX.value = x;
    listener.positionY.value = y;
    listener.positionZ.value = z;
  } else if ("setPosition" in listener) {
    (
      listener as unknown as {
        setPosition: (x: number, y: number, z: number) => void;
      }
    ).setPosition(x, y, z);
  }
}

const DEFAULT_LOCAL_USER: LocalUserAvatar = {
  id: "local-user",
  name: "You (Host)",
  position: { x: 300, y: 200 },
};

const DEFAULT_INITIAL_PEERS: PeerAvatar[] = [
  {
    id: "peer-sarah",
    name: "Sarah (Engineering)",
    position: { x: 140, y: 120 },
    color: "#3b82f6",
  },
  {
    id: "peer-david",
    name: "David (Design)",
    position: { x: 460, y: 130 },
    color: "#10b981",
  },
  {
    id: "peer-elena",
    name: "Elena (Product)",
    position: { x: 420, y: 280 },
    color: "#8b5cf6",
  },
];

export const SpatialAudioStage: React.FC<SpatialAudioStageProps> = ({
  roomId: _roomId = "spatial-room-1",
  localUser: initialLocalUserProp,
  initialPeers,
  peers: controlledPeers,
  peerStreams,
  audioContext: externalAudioContext,
  rolloffFactor: initialRolloff = 1.5,
  refDistance = 1.0,
  maxDistance = 100.0,
  stageWidth = 600,
  stageHeight = 400,
  coordinateScale = 0.05, // 1 stage px = 5cm, so 600px stage = 30 meters
  coordinateMapping = "xz",
  onPeerMove,
  onLocalMove,
  className = "",
  proximityBoundaryZone: initialProximityZoneProp,
  onProximityBoundaryZoneChange,
  showBoundaryRings: initialShowBoundaryRings = true,
}) => {
  // Local user state
  const [localUser, setLocalUser] = useState<LocalUserAvatar>(
    initialLocalUserProp || DEFAULT_LOCAL_USER,
  );

  // Peers state (uncontrolled fallback if controlledPeers not provided)
  const [peersState, setPeersState] = useState<PeerAvatar[]>(
    initialPeers || DEFAULT_INITIAL_PEERS,
  );

  const activePeers = useMemo(
    () => controlledPeers || peersState,
    [controlledPeers, peersState],
  );

  // Configurable rolloff factor
  const [rolloff, setRolloff] = useState<number>(initialRolloff);
  const [isAudioActive, setIsAudioActive] = useState(false);
  const [selectedAvatarId, setSelectedAvatarId] = useState<string | null>(null);

  // Configurable Proximity Fade-out Boundary Zone state
  const [proximityZone, setProximityZone] = useState<ProximityBoundaryZoneConfig>(() =>
    sanitizeProximityZoneConfig(initialProximityZoneProp)
  );
  const [showBoundaryRings, setShowBoundaryRings] = useState<boolean>(initialShowBoundaryRings);

  const handleUpdateProximityZone = useCallback(
    (partial: Partial<ProximityBoundaryZoneConfig>) => {
      setProximityZone((prev) => {
        const updated = sanitizeProximityZoneConfig({ ...prev, ...partial });
        onProximityBoundaryZoneChange?.(updated);
        return updated;
      });
    },
    [onProximityBoundaryZoneChange]
  );

  const handleSelectPreset = useCallback(
    (presetId: ProximityZonePresetId) => {
      if (presetId in PROXIMITY_ZONE_PRESETS) {
        const preset = PROXIMITY_ZONE_PRESETS[presetId as keyof typeof PROXIMITY_ZONE_PRESETS];
        handleUpdateProximityZone(preset);
      }
    },
    [handleUpdateProximityZone]
  );

  // Dragging state
  const stageRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Web Audio Context & Node Chains
  const audioContextRef = useRef<AudioContext | null>(null);
  const ownContextRef = useRef<boolean>(false);
  const chainsRef = useRef<Map<string, PeerAudioChain>>(new Map());

  // 3D Geodesic Radar Dome Refs & State
  const domeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const domeControllerRef = useRef<GeodesicRadarDomeSceneController | null>(
    null,
  );
  const activePeersRef = useRef(activePeers);
  activePeersRef.current = activePeers;
  const localUserRef = useRef(localUser);
  localUserRef.current = localUser;

  // Initialize 3D Geodesic Radar Dome Three.js / WebGL Scene
  useEffect(() => {
    const canvas = domeCanvasRef.current;
    if (!canvas) return;

    const controller = createGeodesicRadarDomeScene(canvas, {
      stageWidth,
      stageHeight,
    });
    domeControllerRef.current = controller;
    controller.updatePeers(activePeersRef.current, localUserRef.current);

    let animationFrameId: number;
    let lastTime = performance.now();

    const renderLoop = (time: number) => {
      const delta = (time - lastTime) / 1000;
      lastTime = time;

      // Sample real-time audio levels from active peer streams
      const peerAudioLevels: Record<string, number> = {};
      let totalAudio = 0;
      chainsRef.current.forEach((chain, peerId) => {
        if (chain.analyser) {
          const lvl = getPeerAudioLevel(chain.analyser);
          peerAudioLevels[peerId] = lvl;
          totalAudio += lvl;
        }
      });

      controller.updatePeers(
        activePeersRef.current,
        localUserRef.current,
        peerAudioLevels,
      );
      controller.animateFrame(delta, totalAudio);

      animationFrameId = requestAnimationFrame(renderLoop);
    };

    animationFrameId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(animationFrameId);
      controller.dispose();
      domeControllerRef.current = null;
    };
  }, [stageWidth, stageHeight]);

  // Initialize AudioContext
  useEffect(() => {
    if (externalAudioContext) {
      audioContextRef.current = externalAudioContext;
      ownContextRef.current = false;
      setIsAudioActive(externalAudioContext.state === "running");
    } else if (typeof window !== "undefined") {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;

      if (AudioCtxClass) {
        try {
          const ctx = new AudioCtxClass();
          audioContextRef.current = ctx;
          ownContextRef.current = true;
          setIsAudioActive(ctx.state === "running");

          const handleState = () => setIsAudioActive(ctx.state === "running");
          ctx.addEventListener("statechange", handleState);

          const chains = chainsRef.current;
          return () => {
            ctx.removeEventListener("statechange", handleState);
            chains.forEach((chain) => {
              try {
                chain.source.disconnect();
                chain.analyser?.disconnect();
                chain.panner.disconnect();
                chain.gain.disconnect();
              } catch {}
            });
            chains.clear();
            if (ctx.state !== "closed") {
              ctx.close().catch(() => {});
            }
          };
        } catch {
          // In test environments without full AudioContext support
        }
      }
    }
  }, [externalAudioContext]);

  // Sync listener position when localUser changes
  useEffect(() => {
    const ctx = audioContextRef.current;
    if (!ctx || !ctx.listener) return;

    const audioPos = stageToAudioCoordinates(
      localUser.position,
      coordinateScale,
      coordinateMapping,
    );
    updateListenerCoordinates(ctx.listener, audioPos.x, audioPos.y, audioPos.z);
  }, [localUser.position, coordinateScale, coordinateMapping]);

  // Distance computation between local user and peer (in meters)
  const calculateDistanceMeters = useCallback(
    (peerPos: StagePosition) => {
      const dx = (peerPos.x - localUser.position.x) * coordinateScale;
      const dy = (peerPos.y - localUser.position.y) * coordinateScale;
      const dz =
        ((peerPos.z ?? 0) - (localUser.position.z ?? 0)) * coordinateScale;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    },
    [localUser.position, coordinateScale],
  );

  // Computes peer gain combining mute state with proximity boundary zone fade
  const calculatePeerGain = useCallback(
    (peerPos: StagePosition, isMuted?: boolean) => {
      if (isMuted) return 0;
      const dist = calculateDistanceMeters(peerPos);
      return calculateProximityFadeGain(dist, proximityZone);
    },
    [calculateDistanceMeters, proximityZone]
  );

  // Recalculates gain across all connected audio chains
  const updateAllPeerGains = useCallback(() => {
    const ctx = audioContextRef.current;
    if (!ctx) return;
    chainsRef.current.forEach((chain, peerId) => {
      const peer = activePeers.find((p) => p.id === peerId);
      if (peer) {
        const targetGain = calculatePeerGain(peer.position, peer.isMuted);
        if (chain.gain.gain.setTargetAtTime) {
          chain.gain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.05);
        } else {
          chain.gain.gain.value = targetGain;
        }
      }
    });
  }, [activePeers, calculatePeerGain]);

  useEffect(() => {
    updateAllPeerGains();
  }, [localUser.position, proximityZone, updateAllPeerGains]);

  // Connect or update peer audio streams to PannerNode (HRTF & inverse distance)
  useEffect(() => {
    const ctx = audioContextRef.current;
    if (!ctx) return;

    const currentChains = chainsRef.current;
    const activePeerIds = new Set<string>();

    activePeers.forEach((peer) => {
      activePeerIds.add(peer.id);

      // Determine stream from peer object or peerStreams lookup
      let stream: MediaStream | null = peer.audioStream || null;
      if (!stream && peerStreams) {
        if (peerStreams instanceof Map) {
          stream = peerStreams.get(peer.id) || null;
        } else if (typeof peerStreams === "object") {
          stream =
            (peerStreams as Record<string, MediaStream>)[peer.id] || null;
        }
      }

      let chain = currentChains.get(peer.id);

      // If stream changed or new chain needed
      if (stream && (!chain || chain.stream !== stream)) {
        if (chain) {
          try {
            chain.source.disconnect();
            chain.analyser?.disconnect();
            chain.panner.disconnect();
            chain.gain.disconnect();
          } catch {}
          currentChains.delete(peer.id);
        }

        try {
          // 1. Instantiate PannerNode with HRTF and inverse distance attenuation
          let panner: PannerNode;
          if (typeof PannerNode === "function") {
            panner = new PannerNode(ctx, {
              panningModel: "HRTF",
              distanceModel: "inverse",
              refDistance,
              maxDistance,
              rolloffFactor: rolloff,
            });
          } else {
            panner = ctx.createPanner();
            panner.panningModel = "HRTF";
            panner.distanceModel = "inverse";
            panner.refDistance = refDistance;
            panner.maxDistance = maxDistance;
            panner.rolloffFactor = rolloff;
          }

          // Ensure explicit HRTF & inverse model settings
          panner.panningModel = "HRTF";
          panner.distanceModel = "inverse";
          panner.rolloffFactor = rolloff;

          // 2. Initial position
          const audioCoords = stageToAudioCoordinates(
            peer.position,
            coordinateScale,
            coordinateMapping,
          );
          updatePannerCoordinates(
            panner,
            audioCoords.x,
            audioCoords.y,
            audioCoords.z,
          );

          // 3. Connect audio graph: source -> panner -> gain -> destination
          // and tap AnalyserNode to drive 3D dome surface ripples
          const source = ctx.createMediaStreamSource(stream);
          let analyser: AnalyserNode | undefined;
          if (typeof ctx.createAnalyser === "function") {
            try {
              analyser = ctx.createAnalyser();
              analyser.fftSize = 64;
              analyser.smoothingTimeConstant = 0.4;
              source.connect(analyser);
            } catch {}
          }
          const gain = ctx.createGain();
          gain.gain.value = calculatePeerGain(peer.position, peer.isMuted);

          source.connect(panner);
          panner.connect(gain);
          if (ctx.destination) {
            gain.connect(ctx.destination);
          }

          chain = {
            peerId: peer.id,
            source,
            analyser,
            panner,
            gain,
            stream,
          };
          currentChains.set(peer.id, chain);
        } catch {
          // Audio routing error fallback
        }
      } else if (chain) {
        // Update existing chain position and mute state
        const audioCoords = stageToAudioCoordinates(
          peer.position,
          coordinateScale,
          coordinateMapping,
        );
        updatePannerCoordinates(
          chain.panner,
          audioCoords.x,
          audioCoords.y,
          audioCoords.z,
        );
        chain.panner.rolloffFactor = rolloff;
        chain.gain.gain.value = calculatePeerGain(peer.position, peer.isMuted);
      }
    });

    // Cleanup disconnected peers
    for (const [peerId, chain] of Array.from(currentChains.entries())) {
      if (!activePeerIds.has(peerId)) {
        try {
          chain.source.disconnect();
          chain.analyser?.disconnect();
          chain.panner.disconnect();
          chain.gain.disconnect();
        } catch {}
        currentChains.delete(peerId);
      }
    }
  }, [
    activePeers,
    peerStreams,
    refDistance,
    maxDistance,
    rolloff,
    coordinateScale,
    coordinateMapping,
  ]);

  // Update rolloff factor across all existing panners
  const handleRolloffChange = (newRolloff: number) => {
    setRolloff(newRolloff);
    chainsRef.current.forEach((chain) => {
      try {
        chain.panner.rolloffFactor = newRolloff;
      } catch {}
    });
  };

  // Resume AudioContext on user interaction
  const resumeAudio = async () => {
    const ctx = audioContextRef.current;
    if (ctx && ctx.state === "suspended") {
      await ctx.resume();
      setIsAudioActive(ctx.state === "running");
    }
  };

  // Dragging handlers
  const handlePointerDown = (
    id: string,
    pos: StagePosition,
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    resumeAudio();

    if (!stageRef.current) return;
    const stageRect = stageRef.current.getBoundingClientRect();
    const rawClientX = Number.isFinite(e.clientX)
      ? e.clientX
      : ((e.nativeEvent as MouseEvent)?.clientX ?? pos.x);
    const rawClientY = Number.isFinite(e.clientY)
      ? e.clientY
      : ((e.nativeEvent as MouseEvent)?.clientY ?? pos.y);

    const stageLeft = stageRect?.left ?? 0;
    const stageTop = stageRect?.top ?? 0;
    const currentX = rawClientX - stageLeft;
    const currentY = rawClientY - stageTop;

    dragOffsetRef.current = {
      x: Number.isFinite(currentX - pos.x) ? currentX - pos.x : 0,
      y: Number.isFinite(currentY - pos.y) ? currentY - pos.y : 0,
    };
    setDraggingId(id);
    setSelectedAvatarId(id);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingId || !stageRef.current) return;
    const stageRect = stageRef.current.getBoundingClientRect();

    const rawClientX = Number.isFinite(e.clientX)
      ? e.clientX
      : ((e.nativeEvent as MouseEvent)?.clientX ?? 0);
    const rawClientY = Number.isFinite(e.clientY)
      ? e.clientY
      : ((e.nativeEvent as MouseEvent)?.clientY ?? 0);

    const stageLeft = stageRect?.left ?? 0;
    const stageTop = stageRect?.top ?? 0;
    const offsetX = dragOffsetRef.current?.x ?? 0;
    const offsetY = dragOffsetRef.current?.y ?? 0;

    const rawX = rawClientX - stageLeft - offsetX;
    const rawY = rawClientY - stageTop - offsetY;

    // Clamp inside stage boundaries (radius 24px padding)
    const clampedX = Math.max(24, Math.min(stageWidth - 24, rawX));
    const clampedY = Math.max(24, Math.min(stageHeight - 24, rawY));
    const newPos: StagePosition = {
      x: Math.round(clampedX),
      y: Math.round(clampedY),
    };

    if (draggingId === "local-user") {
      setLocalUser((prev) => ({ ...prev, position: newPos }));
      onLocalMove?.(newPos);
    } else {
      setPeersState((prev) =>
        prev.map((p) => (p.id === draggingId ? { ...p, position: newPos } : p)),
      );
      onPeerMove?.(draggingId, newPos);

      // Dynamically update PannerNode coordinates immediately
      const chain = chainsRef.current.get(draggingId);
      if (chain) {
        const audioPos = stageToAudioCoordinates(
          newPos,
          coordinateScale,
          coordinateMapping,
        );
        updatePannerCoordinates(
          chain.panner,
          audioPos.x,
          audioPos.y,
          audioPos.z,
        );
        const peer = activePeers.find((p) => p.id === draggingId);
        const pGain = calculatePeerGain(newPos, peer?.isMuted);
        if (chain.gain.gain.setTargetAtTime) {
          chain.gain.gain.setTargetAtTime(
            pGain,
            audioContextRef.current?.currentTime || 0,
            0.05
          );
        } else {
          chain.gain.gain.value = pGain;
        }
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingId) {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      setDraggingId(null);
    }
  };

  return (
    <div
      data-testid="spatial-audio-stage"
      className={`relative flex flex-col rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 ${className}`}
    >
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div>
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-blue-500 animate-pulse" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-100">
              Virtual Room Spatial Audio Stage
            </h2>
            <span
              data-testid="panning-model-badge"
              className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-mono font-semibold text-blue-600 dark:text-blue-400 border border-blue-500/20"
            >
              HRTF 3D Panner
            </span>
            <span
              data-testid="distance-model-badge"
              className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-mono font-semibold text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
            >
              Inverse Attenuation
            </span>
            <span
              data-testid="geodesic-dome-badge"
              className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-mono font-semibold text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Geodesic Radar Dome 3D
            </span>
            {proximityZone.enabled && (
              <span
                data-testid="proximity-zone-badge"
                className="flex items-center gap-1 rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-mono font-semibold text-indigo-600 dark:text-indigo-400 border border-indigo-500/20"
              >
                <Disc className="h-3 w-3 text-indigo-500" />
                Zone: {proximityZone.innerRadius}m - {proximityZone.outerRadius}m ({proximityZone.fadeCurve})
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Drag avatars around the room floor. Audio pans and attenuates
            binaurally based on distance.
          </p>
        </div>

        {/* Audio Context Status / Resume Gesture Button */}
        <div className="flex items-center gap-2">
          {!isAudioActive && (
            <button
              type="button"
              data-testid="resume-audio-btn"
              onClick={resumeAudio}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-blue-700 transition active:scale-95"
            >
              <Headphones className="h-3.5 w-3.5" />
              Enable Spatial Audio
            </button>
          )}
          <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300">
            <Users className="h-3.5 w-3.5 text-zinc-400" />
            {activePeers.length + 1} Coworkers
          </span>
        </div>
      </div>

      {/* Stage Floor Canvas */}
      <div className="mt-4 flex flex-col items-center">
        <div
          ref={stageRef}
          data-testid="stage-canvas"
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          style={{ width: stageWidth, height: stageHeight }}
          className="relative select-none overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-900 shadow-inner dark:border-zinc-800 touch-none"
        >
          {/* 3D Geodesic Radar Dome WebGL Canvas Layer */}
          <canvas
            ref={domeCanvasRef}
            data-testid="geodesic-radar-dome"
            width={stageWidth}
            height={stageHeight}
            className="absolute inset-0 pointer-events-none z-0"
            style={{ width: stageWidth, height: stageHeight }}
          />

          {/* Floor grid markings */}
          <div
            className="absolute inset-0 opacity-15 pointer-events-none z-[1]"
            style={{
              backgroundImage:
                "radial-gradient(circle, #3b82f6 1px, transparent 1px), linear-gradient(to right, #3f3f46 1px, transparent 1px), linear-gradient(to bottom, #3f3f46 1px, transparent 1px)",
              backgroundSize: "24px 24px, 120px 120px, 120px 120px",
            }}
          />

          {/* Sound propagation rings around local user */}
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-blue-500/25 animate-ping"
            style={{
              left: localUser.position.x,
              top: localUser.position.y,
              width: 120,
              height: 120,
              animationDuration: "3s",
            }}
          />
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-blue-500/15"
            style={{
              left: localUser.position.x,
              top: localUser.position.y,
              width: 240,
              height: 240,
            }}
          />

          {/* Proximity Boundary Zones (Inner Core & Outer Cutoff) */}
          {proximityZone.enabled && showBoundaryRings && (
            <div
              data-testid="proximity-boundary-rings"
              className="pointer-events-none absolute inset-0 overflow-hidden"
            >
              {/* Outer Cutoff Boundary Ring & Fade Corridor Fill */}
              <div
                data-testid="outer-boundary-ring"
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-indigo-500/35 transition-all duration-300"
                style={{
                  left: localUser.position.x,
                  top: localUser.position.y,
                  width: (proximityZone.outerRadius / coordinateScale) * 2,
                  height: (proximityZone.outerRadius / coordinateScale) * 2,
                  background:
                    "radial-gradient(circle, rgba(99, 102, 241, 0.08) 0%, rgba(99, 102, 241, 0.03) 70%, rgba(99, 102, 241, 0) 100%)",
                }}
              >
                <span className="absolute top-1 left-1/2 -translate-x-1/2 rounded bg-indigo-950/80 px-1.5 py-0.5 text-[9px] font-mono font-semibold text-indigo-300">
                  Cutoff: {proximityZone.outerRadius}m
                </span>
              </div>

              {/* Inner Core Presence Boundary Ring (100% Volume) */}
              <div
                data-testid="inner-boundary-ring"
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-emerald-500/50 bg-emerald-500/10 transition-all duration-300"
                style={{
                  left: localUser.position.x,
                  top: localUser.position.y,
                  width: (proximityZone.innerRadius / coordinateScale) * 2,
                  height: (proximityZone.innerRadius / coordinateScale) * 2,
                }}
              >
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded bg-emerald-950/80 px-1.5 py-0.5 text-[9px] font-mono font-semibold text-emerald-300">
                  Core Presence: {proximityZone.innerRadius}m (100%)
                </span>
              </div>
            </div>
          )}

          {/* Local User Avatar */}
          <div
            data-testid="avatar-local"
            onPointerDown={(e) =>
              handlePointerDown("local-user", localUser.position, e)
            }
            style={{
              left: localUser.position.x,
              top: localUser.position.y,
            }}
            className="group absolute -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing z-20"
          >
            <div className="relative flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-tr from-blue-600 to-indigo-500 text-white shadow-lg ring-4 ring-blue-500/30 transition-transform group-hover:scale-105">
              <Headphones className="h-5 w-5" />
              <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-zinc-900" />
            </div>
            <div className="absolute top-14 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-950/90 px-2 py-0.5 text-[10px] font-bold text-zinc-100 shadow backdrop-blur">
              {localUser.name} (Listener)
            </div>
          </div>

          {/* Peer Coworker Avatars */}
          {activePeers.map((peer) => {
            const distMeters = calculateDistanceMeters(peer.position);
            const isSelected = selectedAvatarId === peer.id;
            const tier = getProximityZoneTier(distMeters, proximityZone);
            const effectiveGain = calculatePeerGain(peer.position, peer.isMuted);
            const gainPercent = Math.round(effectiveGain * 100);

            return (
              <div
                key={peer.id}
                data-testid={`avatar-${peer.id}`}
                onPointerDown={(e) =>
                  handlePointerDown(peer.id, peer.position, e)
                }
                style={{
                  left: peer.position.x,
                  top: peer.position.y,
                }}
                className="group absolute -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing z-10"
              >
                {/* Distance line to local user when selected */}
                {isSelected && (
                  <svg
                    className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-visible"
                    style={{ width: 0, height: 0 }}
                  >
                    <line
                      x1={0}
                      y1={0}
                      x2={localUser.position.x - peer.position.x}
                      y2={localUser.position.y - peer.position.y}
                      stroke="#3b82f6"
                      strokeWidth="1.5"
                      strokeDasharray="4 4"
                    />
                  </svg>
                )}

                <div
                  style={{
                    backgroundColor: peer.color || "#6366f1",
                  }}
                  className="relative flex h-11 w-11 items-center justify-center rounded-full text-white shadow-md ring-2 ring-white/20 transition-transform group-hover:scale-110"
                >
                  <span className="text-xs font-bold uppercase">
                    {peer.name.slice(0, 2)}
                  </span>
                  {peer.isMuted ? (
                    <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] text-white ring-2 ring-zinc-900">
                      <VolumeX className="h-2.5 w-2.5" />
                    </span>
                  ) : (
                    <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-zinc-900">
                      <Volume2 className="h-2 w-2 text-white" />
                    </span>
                  )}
                </div>

                {/* Badge tooltip */}
                <div className="absolute top-13 left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none">
                  <span className="whitespace-nowrap rounded-md bg-zinc-950/90 px-2 py-0.5 text-[10px] font-semibold text-zinc-100 shadow backdrop-blur">
                    {peer.name}
                  </span>
                  <div className="mt-0.5 flex items-center gap-1">
                    <span
                      data-testid={`peer-distance-${peer.id}`}
                      className="whitespace-nowrap rounded px-1.5 py-0.2 text-[9px] font-mono text-blue-400 bg-blue-950/60"
                    >
                      {distMeters.toFixed(1)}m away
                    </span>
                    {proximityZone.enabled && (
                      <span
                        data-testid={`peer-zone-tier-${peer.id}`}
                        className={`whitespace-nowrap rounded px-1.5 py-0.2 text-[9px] font-mono font-medium ${
                          tier === "core_presence"
                            ? "bg-emerald-950/80 text-emerald-300"
                            : tier === "fade_corridor"
                            ? "bg-amber-950/80 text-amber-300"
                            : "bg-red-950/80 text-red-300"
                        }`}
                      >
                        {gainPercent}% vol ({tier === "core_presence" ? "Core" : tier === "fade_corridor" ? "Fade" : "Cutoff"})
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Proximity Boundary Zone Controls Card */}
      <div
        data-testid="proximity-zone-controls"
        className="mt-4 flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/70"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-2.5 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <Disc className="h-4 w-4 text-indigo-500" />
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-200">
              Acoustic Proximity Boundary Zones
            </span>
            <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-indigo-600 dark:text-indigo-400">
              Multi-Tier Spatial Roll-off
            </span>
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                data-testid="proximity-zone-enabled-toggle"
                checked={proximityZone.enabled}
                onChange={(e) => handleUpdateProximityZone({ enabled: e.target.checked })}
                className="h-3.5 w-3.5 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
              />
              Enable Zones
            </label>

            <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                data-testid="toggle-boundary-rings"
                checked={showBoundaryRings}
                onChange={(e) => setShowBoundaryRings(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
              />
              Show Rings
            </label>
          </div>
        </div>

        {/* Presets Bar */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 mr-1">
            Presets:
          </span>
          {(
            [
              { id: "intimate_desk", name: "Intimate Desk" },
              { id: "team_pod", name: "Team Pod" },
              { id: "open_floor", name: "Open Floor" },
              { id: "broadcast", name: "Broadcast" },
              { id: "whisper_quiet", name: "Whisper Quiet" },
            ] as const
          ).map((preset) => {
            const isSelected = proximityZone.presetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                data-testid={`preset-btn-${preset.id}`}
                onClick={() => handleSelectPreset(preset.id)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                  isSelected
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700 dark:hover:bg-zinc-700/80"
                }`}
              >
                {preset.name}
              </button>
            );
          })}
        </div>

        {/* Sliders and Curve Grid */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4 pt-1">
          {/* Inner Radius Slider */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="inner-radius-slider" className="font-medium text-zinc-600 dark:text-zinc-300">
                Core Radius
              </label>
              <span
                data-testid="inner-radius-value"
                className="font-mono font-bold text-emerald-600 dark:text-emerald-400"
              >
                {proximityZone.innerRadius.toFixed(1)}m
              </span>
            </div>
            <input
              id="inner-radius-slider"
              data-testid="inner-radius-slider"
              type="range"
              min="0.5"
              max="15.0"
              step="0.5"
              value={proximityZone.innerRadius}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                handleUpdateProximityZone({
                  innerRadius: val,
                  outerRadius: Math.max(val + 0.5, proximityZone.outerRadius),
                });
              }}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-300 accent-emerald-600 dark:bg-zinc-700"
            />
            <span className="text-[10px] text-zinc-500">100% gain zone</span>
          </div>

          {/* Outer Radius Slider */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="outer-radius-slider" className="font-medium text-zinc-600 dark:text-zinc-300">
                Cutoff Boundary
              </label>
              <span
                data-testid="outer-radius-value"
                className="font-mono font-bold text-indigo-600 dark:text-indigo-400"
              >
                {proximityZone.outerRadius.toFixed(1)}m
              </span>
            </div>
            <input
              id="outer-radius-slider"
              data-testid="outer-radius-slider"
              type="range"
              min="1.0"
              max="35.0"
              step="0.5"
              value={proximityZone.outerRadius}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                handleUpdateProximityZone({
                  outerRadius: Math.max(proximityZone.innerRadius + 0.5, val),
                });
              }}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-300 accent-indigo-600 dark:bg-zinc-700"
            />
            <span className="text-[10px] text-zinc-500">Fade-out threshold</span>
          </div>

          {/* Fade Curve Selector */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="fade-curve-select" className="font-medium text-zinc-600 dark:text-zinc-300">
                Fade Curve
              </label>
              <span
                data-testid="fade-curve-value"
                className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400"
              >
                {proximityZone.fadeCurve}
              </span>
            </div>
            <select
              id="fade-curve-select"
              data-testid="fade-curve-select"
              value={proximityZone.fadeCurve}
              onChange={(e) =>
                handleUpdateProximityZone({ fadeCurve: e.target.value as FadeOutCurve })
              }
              className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-800 shadow-sm focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
            >
              <option value="smoothstep">Smoothstep (Hermite)</option>
              <option value="exponential">Exponential (Natural)</option>
              <option value="linear">Linear</option>
              <option value="cosine">Cosine</option>
              <option value="logarithmic">Logarithmic (dB)</option>
            </select>
            <span className="text-[10px] text-zinc-500">Corridor taper math</span>
          </div>

          {/* Minimum Gain Floor Slider */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="min-gain-floor-slider" className="font-medium text-zinc-600 dark:text-zinc-300">
                Whisper Floor
              </label>
              <span
                data-testid="min-gain-floor-value"
                className="font-mono font-bold text-zinc-600 dark:text-zinc-300"
              >
                {(proximityZone.minGainFloor * 100).toFixed(0)}%
              </span>
            </div>
            <input
              id="min-gain-floor-slider"
              data-testid="min-gain-floor-slider"
              type="range"
              min="0.0"
              max="0.2"
              step="0.01"
              value={proximityZone.minGainFloor}
              onChange={(e) =>
                handleUpdateProximityZone({ minGainFloor: parseFloat(e.target.value) })
              }
              className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-300 accent-zinc-600 dark:bg-zinc-700"
            />
            <span className="text-[10px] text-zinc-500">Silence vs background</span>
          </div>
        </div>
      </div>

      {/* Acoustic Settings and Controls Footer */}
      <div className="mt-4 grid grid-cols-1 gap-4 border-t border-zinc-200 pt-4 dark:border-zinc-800 sm:grid-cols-2">
        {/* Distance Rolloff Factor Slider */}
        <div className="flex flex-col gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
          <div className="flex items-center justify-between">
            <label
              htmlFor="rolloff-slider"
              className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300"
            >
              <Sliders className="h-3.5 w-3.5 text-blue-500" />
              Inverse Distance Rolloff Factor
            </label>
            <span
              data-testid="rolloff-value"
              className="text-xs font-mono font-bold text-blue-600 dark:text-blue-400"
            >
              {rolloff.toFixed(1)}x
            </span>
          </div>
          <input
            id="rolloff-slider"
            data-testid="rolloff-slider"
            type="range"
            min="0.1"
            max="4.0"
            step="0.1"
            value={rolloff}
            onChange={(e) => handleRolloffChange(parseFloat(e.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-300 accent-blue-600 dark:bg-zinc-700"
          />
          <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
            Higher values attenuate distant coworkers faster, creating focused
            quiet zones.
          </p>
        </div>

        {/* Coords & Panning Diagnostics */}
        <div className="flex flex-col justify-between rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
          <div className="flex items-center justify-between text-xs font-semibold text-zinc-700 dark:text-zinc-300">
            <span className="flex items-center gap-1.5">
              <Move className="h-3.5 w-3.5 text-purple-500" />
              Listener Position
            </span>
            <span className="font-mono text-zinc-500 dark:text-zinc-400">
              ({localUser.position.x}px, {localUser.position.y}px)
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1">
              <Sparkles className="h-3 w-3 text-amber-500" />
              Ref: {refDistance}m • Max: {maxDistance}m
            </span>
            <span className="font-mono text-[10px]">
              Scale: {(1 / coordinateScale).toFixed(0)}px/m
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SpatialAudioStage;
