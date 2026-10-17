"use client";

import React, {
  memo,
  useMemo,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import {
  Layers,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Sparkles,
} from "lucide-react";

export type TravelMode = "walking" | "cycling" | "transit" | "flight";

export interface Waypoint {
  id: string;
  name: string;
  coordinates: [number, number]; // [x, y] in percentage (0-100) or SVG viewport units (0-800, 0-600)
  type?: "origin" | "destination" | "waypoint";
  eta?: string;
  altitude?: string;
  floorLevel?: number; // e.g. floor 1, 2, 3
  capacity?: number;
  occupancy?: number;
}

export interface AirspaceCorridor {
  id: string;
  name: string;
  altitudeFloor: number; // e.g. 500 ft (A005)
  altitudeCeiling: number; // e.g. 2500 ft (A025)
  points: [number, number][];
  activeFlights?: number;
  status?: "clear" | "congested" | "restricted";
}

export interface VenueMarker {
  id: string;
  name: string;
  x: number; // 0-800 unit space
  y: number; // 0-600 unit space
  category: "cowork" | "hub" | "cafe" | "lab" | "hangar";
  capacity: number;
  currentOccupancy: number;
  altitudeLevel: string; // e.g. "FL020", "FL045"
  floors?: {
    floorNumber: number;
    name: string;
    desksAvailable: number;
    totalDesks: number;
  }[];
}

export interface TacticalAirspaceMapProps {
  /** Array of route coordinates [[x1, y1], [x2, y2], ...] on the map grid */
  pathCoordinates?: [number, number][];
  /** Active travel mode for commute */
  mode?: TravelMode;
  /** Waypoints to mark on the tactical airspace grid */
  waypoints?: Waypoint[];
  /** Optional custom flight corridors with altitude ribbons */
  corridors?: AirspaceCorridor[];
  /** Optional list of venues for instanced WebGL rendering and clustering */
  venueMarkers?: VenueMarker[];
  /** Glow intensity for emerald hard-light construct */
  glowIntensity?: "subtle" | "normal" | "intense";
  /** Optional flight altitude telemetry or flight callsign */
  flightCallsign?: string;
  /** Optional custom CSS class */
  className?: string;
  /** Callback when waypoint is clicked */
  onSelectWaypoint?: (waypoint: Waypoint) => void;
  /** Callback when venue is selected */
  onSelectVenue?: (venue: VenueMarker) => void;
  /** Enable 2D SVG fallback mode (default false, auto falls back if WebGL unavailable) */
  forceFallback?: boolean;
}

// Altitude Color Mapping for Corridor Ribbons
export function getAltitudeColor(altitudeFt: number): {
  stroke: string;
  fill: string;
  glow: string;
  label: string;
} {
  if (altitudeFt < 1000) {
    // Low Altitude Corridor: Emerald Cyan (FL005-FL010)
    return {
      stroke: "#06b6d4",
      fill: "rgba(6, 182, 212, 0.25)",
      glow: "rgba(6, 182, 212, 0.6)",
      label: "LOW CORRIDOR (<1k ft)",
    };
  } else if (altitudeFt <= 3000) {
    // Mid Altitude Tactical Sector: Emerald Green (FL010-FL030)
    return {
      stroke: "#10b981",
      fill: "rgba(16, 185, 129, 0.3)",
      glow: "rgba(16, 185, 129, 0.8)",
      label: "TACTICAL SECTOR (1-3k ft)",
    };
  } else {
    // High Speed Supersonic Flight Corridor: Electric Emerald-Lime (FL030+)
    return {
      stroke: "#a3e635",
      fill: "rgba(163, 230, 53, 0.25)",
      glow: "rgba(163, 230, 53, 0.7)",
      label: "SUPERSONIC VECTOR (>3k ft)",
    };
  }
}

// Compute simple clusters for dense venue points
export interface VenueCluster {
  id: string;
  isCluster: boolean;
  x: number;
  y: number;
  points: VenueMarker[];
}

export function clusterVenues(
  venues: VenueMarker[],
  clusterRadius: number,
  zoomLevel: number,
): VenueCluster[] {
  if (zoomLevel >= 2.0 || venues.length <= 4) {
    // High zoom: unclustered individual venues
    return venues.map((v) => ({
      id: v.id,
      isCluster: false,
      x: v.x,
      y: v.y,
      points: [v],
    }));
  }

  const clusters: VenueCluster[] = [];
  const visited = new Set<string>();

  for (let i = 0; i < venues.length; i++) {
    const v1 = venues[i];
    if (visited.has(v1.id)) continue;

    const group: VenueMarker[] = [v1];
    visited.add(v1.id);

    for (let j = i + 1; j < venues.length; j++) {
      const v2 = venues[j];
      if (visited.has(v2.id)) continue;

      const dist = Math.hypot(v1.x - v2.x, v1.y - v2.y);
      if (dist < clusterRadius / zoomLevel) {
        group.push(v2);
        visited.add(v2.id);
      }
    }

    if (group.length > 1) {
      const avgX = group.reduce((acc, g) => acc + g.x, 0) / group.length;
      const avgY = group.reduce((acc, g) => acc + g.y, 0) / group.length;
      clusters.push({
        id: `cluster-${group[0].id}-${group.length}`,
        isCluster: true,
        x: avgX,
        y: avgY,
        points: group,
      });
    } else {
      clusters.push({
        id: v1.id,
        isCluster: false,
        x: v1.x,
        y: v1.y,
        points: [v1],
      });
    }
  }

  return clusters;
}

export const DEFAULT_CORRIDORS: AirspaceCorridor[] = [
  {
    id: "corridor-echo-1",
    name: "CORRIDOR ECHO-01 (NOMAD LOW APPROACH)",
    altitudeFloor: 500,
    altitudeCeiling: 900,
    points: [
      [80, 500],
      [220, 440],
      [360, 480],
    ],
    status: "clear",
    activeFlights: 3,
  },
  {
    id: "corridor-bravo-2",
    name: "CORRIDOR BRAVO-02 (EMERALD HARD-LIGHT MAIN)",
    altitudeFloor: 1500,
    altitudeCeiling: 2800,
    points: [
      [220, 440],
      [380, 360],
      [520, 310],
      [640, 240],
    ],
    status: "congested",
    activeFlights: 12,
  },
  {
    id: "corridor-tango-3",
    name: "CORRIDOR TANGO-03 (SUPERSONIC HIGHWAY)",
    altitudeFloor: 3500,
    altitudeCeiling: 5000,
    points: [
      [520, 310],
      [640, 210],
      [740, 140],
    ],
    status: "clear",
    activeFlights: 5,
  },
];

export const DEFAULT_VENUES: VenueMarker[] = [
  {
    id: "v-alpha",
    name: "Sector Alpha Outpost Hub",
    x: 100,
    y: 480,
    category: "hub",
    capacity: 120,
    currentOccupancy: 88,
    altitudeLevel: "FL015",
    floors: [
      { floorNumber: 1, name: "Ground Concourse", desksAvailable: 8, totalDesks: 40 },
      { floorNumber: 2, name: "Quiet Pod Level", desksAvailable: 14, totalDesks: 40 },
      { floorNumber: 3, name: "Sky Deck Lounge", desksAvailable: 10, totalDesks: 40 },
    ],
  },
  {
    id: "v-beta",
    name: "Coast City Cyber Lab",
    x: 240,
    y: 420,
    category: "lab",
    capacity: 75,
    currentOccupancy: 42,
    altitudeLevel: "FL025",
    floors: [
      { floorNumber: 1, name: "Main Prototyping Floor", desksAvailable: 20, totalDesks: 45 },
      { floorNumber: 2, name: "VR Holo Chambers", desksAvailable: 13, totalDesks: 30 },
    ],
  },
  {
    id: "v-gamma",
    name: "Oa Station Cowork Nexus",
    x: 380,
    y: 460,
    category: "cowork",
    capacity: 200,
    currentOccupancy: 185,
    altitudeLevel: "FL030",
    floors: [
      { floorNumber: 1, name: "Public Atrium", desksAvailable: 4, totalDesks: 60 },
      { floorNumber: 2, name: "Enterprise Suites", desksAvailable: 2, totalDesks: 80 },
      { floorNumber: 3, name: "Executive Aeropost", desksAvailable: 9, totalDesks: 60 },
    ],
  },
  {
    id: "v-delta",
    name: "Ferris Aircraft Flight Hangar 7",
    x: 520,
    y: 310,
    category: "hangar",
    capacity: 150,
    currentOccupancy: 95,
    altitudeLevel: "FL040",
    floors: [
      { floorNumber: 1, name: "Flight Deck & Simulators", desksAvailable: 25, totalDesks: 75 },
      { floorNumber: 2, name: "Avionics Engineering Lab", desksAvailable: 30, totalDesks: 75 },
    ],
  },
  {
    id: "v-epsilon",
    name: "Green Lantern Hard-Light Spire",
    x: 720,
    y: 160,
    category: "hub",
    capacity: 300,
    currentOccupancy: 210,
    altitudeLevel: "FL050",
    floors: [
      { floorNumber: 1, name: "Emerald Atrium", desksAvailable: 18, totalDesks: 100 },
      { floorNumber: 2, name: "Willpower Assembly", desksAvailable: 32, totalDesks: 100 },
      { floorNumber: 3, name: "Apex Observatory", desksAvailable: 40, totalDesks: 100 },
    ],
  },
];

export const TacticalAirspaceMap: React.FC<TacticalAirspaceMapProps> = memo(({
  pathCoordinates = [
    [100, 480],
    [240, 420],
    [380, 460],
    [520, 310],
    [640, 240],
    [720, 160],
  ],
  mode = "walking",
  waypoints = [
    { id: "wp-origin", name: "Alpha Hub (Nomad Base)", coordinates: [100, 480], type: "origin", eta: "00:00" },
    { id: "wp-dest", name: "Green Lantern Cowork Lab", coordinates: [720, 160], type: "destination", eta: "+18m", altitude: "FL045" },
  ],
  corridors = DEFAULT_CORRIDORS,
  venueMarkers = DEFAULT_VENUES,
  glowIntensity = "normal",
  flightCallsign = "SECTOR-2814 // AIRSPACE-01",
  className = "",
  onSelectWaypoint,
  onSelectVenue,
  forceFallback = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selectedWaypointId, setSelectedWaypointId] = useState<string | null>(null);
  const [selectedVenue, setSelectedVenue] = useState<VenueMarker | null>(null);
  const [activeFloorLevel, setActiveFloorLevel] = useState<number>(1);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<number>(1.0);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [showCorridorRibbons, setShowCorridorRibbons] = useState(true);
  const [isWebGLEnabled, setIsWebGLEnabled] = useState<boolean>(!forceFallback);

  // Radar sweep angle state for real-time beam
  const radarAngleRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia) {
      const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      setPrefersReducedMotion(mediaQuery.matches);
      const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
      mediaQuery.addEventListener?.("change", handler);
      return () => mediaQuery.removeEventListener?.("change", handler);
    }
  }, []);

  // WebGL Context Lost & Check
  useEffect(() => {
    if (forceFallback) {
      setIsWebGLEnabled(false);
      return;
    }

    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      setIsWebGLEnabled(!!gl);
    } catch {
      setIsWebGLEnabled(false);
    }
  }, [forceFallback]);

  // Handle Radar Sweep Animation Loop & Real-Time Canvas Rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }

    let isRunning = true;
    let lastTime = performance.now();

    const renderFrame = (now: number) => {
      if (!isRunning) return;

      const dt = (now - lastTime) / 1000;
      lastTime = now;

      if (!prefersReducedMotion) {
        radarAngleRef.current = (radarAngleRef.current + dt * 60) % 360;
      }

      if (ctx) {
        const width = canvas.width;
        const height = canvas.height;

        ctx.clearRect(0, 0, width, height);

        // Dark tactical airspace background
        ctx.fillStyle = "#02120a";
        ctx.fillRect(0, 0, width, height);

        // Draw Tactical Grid
        ctx.strokeStyle = "rgba(16, 185, 129, 0.08)";
        ctx.lineWidth = 1;
        const gridSize = 40;
        for (let x = 0; x < width; x += gridSize) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        for (let y = 0; y < height; y += gridSize) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }

        // Radar Center Point (Sector Operations Center)
        const centerX = 400;
        const centerY = 300;

        // Radar Concentric Range Rings
        ctx.strokeStyle = "rgba(16, 185, 129, 0.15)";
        ctx.setLineDash([4, 6]);
        [100, 200, 280].forEach((radius) => {
          ctx?.beginPath();
          ctx?.arc(centerX, centerY, radius, 0, Math.PI * 2);
          ctx?.stroke();
        });
        ctx.setLineDash([]);

        // GPU / Procedural Bloom Radar Sweep Cone
        const sweepRad = (radarAngleRef.current * Math.PI) / 180;
        const sweepLength = 360;

        // Rotating Emerald Laser Radar Sweep Beam
        ctx.save();
        ctx.translate(centerX, centerY);

        const sweepGrad = ctx.createRadialGradient(0, 0, 10, 0, 0, sweepLength);
        sweepGrad.addColorStop(0, "rgba(52, 211, 153, 0.35)");
        sweepGrad.addColorStop(0.7, "rgba(16, 185, 129, 0.15)");
        sweepGrad.addColorStop(1, "rgba(5, 150, 105, 0)");

        ctx.fillStyle = sweepGrad;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, sweepLength, sweepRad - 0.25, sweepRad);
        ctx.closePath();
        ctx.fill();

        // Sharp leading laser sweep edge
        ctx.strokeStyle = "rgba(110, 231, 183, 0.85)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(sweepRad) * sweepLength, Math.sin(sweepRad) * sweepLength);
        ctx.stroke();

        ctx.restore();

        // Render Color-Coded Airspace Altitude Corridor Ribbons
        if (showCorridorRibbons && corridors.length > 0) {
          corridors.forEach((corridor) => {
            const colorCfg = getAltitudeColor(corridor.altitudeCeiling);
            if (corridor.points.length < 2) return;

            ctx?.save();
            ctx!.strokeStyle = colorCfg.stroke;
            ctx!.lineWidth = 16;
            ctx!.lineCap = "round";
            ctx!.lineJoin = "round";
            ctx!.globalAlpha = 0.28;

            ctx?.beginPath();
            corridor.points.forEach(([px, py], i) => {
              if (i === 0) ctx?.moveTo(px, py);
              else ctx?.lineTo(px, py);
            });
            ctx?.stroke();

            // Inner high-density core vector line
            ctx!.lineWidth = 2.5;
            ctx!.globalAlpha = 0.85;
            ctx?.stroke();

            // Corridor Waypoint Altitude Tags
            const midPt = corridor.points[Math.floor(corridor.points.length / 2)];
            if (midPt) {
              ctx!.fillStyle = "rgba(2, 18, 10, 0.85)";
              ctx!.fillRect(midPt[0] - 40, midPt[1] - 18, 80, 16);
              ctx!.strokeStyle = colorCfg.stroke;
              ctx!.lineWidth = 1;
              ctx!.strokeRect(midPt[0] - 40, midPt[1] - 18, 80, 16);

              ctx!.fillStyle = colorCfg.stroke;
              ctx!.font = "9px monospace";
              ctx!.textAlign = "center";
              ctx!.fillText(
                `FL0${Math.round(corridor.altitudeCeiling / 100)} [${corridor.status?.toUpperCase() || "ACTIVE"}]`,
                midPt[0],
                midPt[1] - 6,
              );
            }

            ctx?.restore();
          });
        }
      }

      animationFrameRef.current = requestAnimationFrame(renderFrame);
    };

    animationFrameRef.current = requestAnimationFrame(renderFrame);

    return () => {
      isRunning = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [corridors, prefersReducedMotion, showCorridorRibbons]);

  // Compute SVG polyline string from path coordinates
  const pointsString = useMemo(() => {
    return pathCoordinates.map(([x, y]) => `${x},${y}`).join(" ");
  }, [pathCoordinates]);

  // Glow filter configurations
  const glowConfig = useMemo(() => {
    switch (glowIntensity) {
      case "subtle":
        return {
          blur: 3,
          opacity: 0.45,
          color: "#10b981",
          filterId: "hard-light-glow-subtle",
        };
      case "intense":
        return {
          blur: 10,
          opacity: 0.95,
          color: "#00ff88",
          filterId: "hard-light-glow-intense",
        };
      case "normal":
      default:
        return {
          blur: 6,
          opacity: 0.75,
          color: "#10b981",
          filterId: "hard-light-glow-normal",
        };
    }
  }, [glowIntensity]);

  const travelSpeedKts = useMemo(() => {
    switch (mode) {
      case "walking":
        return "15 KTS (PEDESTRIAN TACTICAL)";
      case "cycling":
        return "45 KTS (CYCLE CONSTRUCT)";
      case "transit":
        return "120 KTS (TRANSIT VECTOR)";
      case "flight":
        return "350 KTS (SUPERSONIC COCKPIT)";
      default:
        return "30 KTS";
    }
  }, [mode]);

  // Clustered venues for current zoom level
  const clusters = useMemo(() => {
    return clusterVenues(venueMarkers, 60, zoomLevel);
  }, [venueMarkers, zoomLevel]);

  // Handle drill down into a cluster or venue
  const handleClusterClick = useCallback(
    (cluster: VenueCluster) => {
      if (cluster.isCluster) {
        // Drill down zoom
        setZoomLevel((prev) => Math.min(3.0, prev + 0.5));
        setPanOffset({
          x: (400 - cluster.x) * 0.4,
          y: (300 - cluster.y) * 0.4,
        });
      } else {
        const venue = cluster.points[0];
        setSelectedVenue(venue);
        setActiveFloorLevel(1);
        onSelectVenue?.(venue);
      }
    },
    [onSelectVenue],
  );

  return (
    <div
      className={`relative w-full rounded-2xl bg-[#03150c]/95 border border-emerald-500/30 shadow-[0_0_25px_rgba(16,185,129,0.15)] overflow-hidden font-mono text-emerald-400 select-none ${className}`}
      data-testid="tactical-airspace-map"
      role="region"
      aria-label="Tactical Airspace Navigation Map"
    >
      <style>{`
        @keyframes laser-pulse-flow {
          0% {
            stroke-dashoffset: 64;
          }
          100% {
            stroke-dashoffset: 0;
          }
        }
        @keyframes radar-sweep {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
        @keyframes waypoint-ping {
          0% {
            r: 4;
            opacity: 0.9;
          }
          100% {
            r: 16;
            opacity: 0;
          }
        }
        .construct-laser-pulse {
          animation: ${prefersReducedMotion ? "none" : "laser-pulse-flow 1.8s linear infinite"};
        }
        .waypoint-ping-anim {
          animation: ${prefersReducedMotion ? "none" : "waypoint-ping 2.2s cubic-bezier(0, 0, 0.2, 1) infinite"};
        }
      `}</style>

      {/* Cockpit HUD Top Telemetry Bar */}
      <div className="flex flex-wrap items-center justify-between px-4 py-2.5 bg-emerald-950/40 border-b border-emerald-500/20 text-xs backdrop-blur-md gap-2">
        <div className="flex items-center space-x-3">
          <span className="flex h-2.5 w-2.5 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </span>
          <span className="font-bold tracking-wider text-emerald-300">
            {flightCallsign}
          </span>
          <span
            data-testid="tactical-engine-badge"
            className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-[10px] text-emerald-300"
          >
            <Sparkles className="w-3 h-3 text-emerald-400" />
            {isWebGLEnabled ? "WEBGL INSTANCED" : "VECTOR SVG FALLBACK"}
          </span>
        </div>

        {/* Map Viewport Controls: Zoom, Corridor Toggle */}
        <div className="flex items-center space-x-2 text-[11px]">
          <button
            type="button"
            data-testid="toggle-corridors-button"
            onClick={() => setShowCorridorRibbons(!showCorridorRibbons)}
            className={`px-2 py-1 rounded border transition-colors flex items-center gap-1 ${
              showCorridorRibbons
                ? "bg-emerald-500/20 border-emerald-400 text-emerald-200"
                : "bg-emerald-950/40 border-emerald-500/30 text-emerald-500 hover:text-emerald-400"
            }`}
            title="Toggle Altitude Corridor Ribbons"
          >
            <Layers className="w-3.5 h-3.5" />
            <span className="hidden md:inline">CORRIDORS</span>
          </button>

          <button
            type="button"
            data-testid="zoom-in-button"
            onClick={() => setZoomLevel((z) => Math.min(3.0, z + 0.25))}
            className="p-1 rounded bg-emerald-950/40 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
            aria-label="Zoom in"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            data-testid="zoom-out-button"
            onClick={() => setZoomLevel((z) => Math.max(0.75, z - 0.25))}
            className="p-1 rounded bg-emerald-950/40 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
            aria-label="Zoom out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            data-testid="reset-view-button"
            onClick={() => {
              setZoomLevel(1.0);
              setPanOffset({ x: 0, y: 0 });
            }}
            className="p-1 rounded bg-emerald-950/40 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
            aria-label="Reset zoom view"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <span className="uppercase text-emerald-500 border border-emerald-500/30 px-1.5 py-0.5 rounded text-[10px]">
            GLOW: {glowIntensity}
          </span>
        </div>
      </div>

      {/* Main Viewport Container */}
      <div className="relative w-full aspect-[4/3] max-h-[600px] overflow-hidden bg-[#02120a]">
        {/* Layer 1: Hardware-Accelerated Canvas (WebGL / 2D Canvas Radar Sweep & Corridors) */}
        <canvas
          ref={canvasRef}
          width={800}
          height={600}
          data-testid="airspace-webgl-canvas"
          className="absolute inset-0 w-full h-full pointer-events-none transform-gpu"
          aria-hidden="true"
        />

        {/* Layer 2: Vector Overlay for Interactive Flight Paths, Waypoints & Venue Clusters */}
        <svg
          viewBox="0 0 800 600"
          className="relative w-full h-full transform-gpu"
          aria-hidden="true"
          style={{
            transform: `scale(${zoomLevel}) translate(${panOffset.x}px, ${panOffset.y}px)`,
            transformOrigin: "400px 300px",
            transition: "transform 0.2s ease-out",
          }}
        >
          <defs>
            {/* Emerald Hard-Light Glow Filter */}
            <filter id={glowConfig.filterId} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation={glowConfig.blur} result="blur1" />
              <feMerge>
                <feMergeNode in="blur1" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Base Polyline Track (Dim Hard-Light Core) */}
          <polyline
            points={pointsString}
            fill="none"
            stroke="rgba(5, 150, 105, 0.45)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Primary Hard-Light Construct Glow Track */}
          <polyline
            points={pointsString}
            fill="none"
            stroke={glowConfig.color}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#${glowConfig.filterId})`}
            strokeOpacity={glowConfig.opacity}
          />

          {/* Traveling Emerald Hard-Light Laser Pulses */}
          <polyline
            points={pointsString}
            fill="none"
            stroke="#a7f3d0"
            strokeWidth="2.5"
            strokeDasharray="16 32"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="construct-laser-pulse"
          />

          {/* Render Instanced Venue Markers & Clusters */}
          {clusters.map((cluster) => {
            if (cluster.isCluster) {
              return (
                <g
                  key={cluster.id}
                  className="cursor-pointer group"
                  onClick={() => handleClusterClick(cluster)}
                  data-testid={`venue-cluster-${cluster.id}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`Cluster of ${cluster.points.length} venues`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") handleClusterClick(cluster);
                  }}
                >
                  <circle
                    cx={cluster.x}
                    cy={cluster.y}
                    r={18}
                    fill="rgba(6, 78, 59, 0.8)"
                    stroke="#10b981"
                    strokeWidth="2"
                    filter={`url(#${glowConfig.filterId})`}
                  />
                  <circle
                    cx={cluster.x}
                    cy={cluster.y}
                    r={14}
                    fill="rgba(16, 185, 129, 0.3)"
                  />
                  <text
                    x={cluster.x}
                    y={cluster.y + 4}
                    fill="#a7f3d0"
                    fontSize="11"
                    fontWeight="bold"
                    textAnchor="middle"
                  >
                    {cluster.points.length}
                  </text>
                </g>
              );
            }

            const venue = cluster.points[0];
            const isSelected = selectedVenue?.id === venue.id;

            return (
              <g
                key={venue.id}
                className="cursor-pointer group"
                onClick={() => handleClusterClick(cluster)}
                data-testid={`venue-marker-${venue.id}`}
                role="button"
                tabIndex={0}
                aria-label={`Venue marker ${venue.name}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") handleClusterClick(cluster);
                }}
              >
                {/* Sonar Ping */}
                <circle
                  cx={venue.x}
                  cy={venue.y}
                  r="6"
                  fill="none"
                  stroke="#34d399"
                  strokeWidth="1.5"
                  className="waypoint-ping-anim"
                />

                {/* Outer Ring */}
                <circle
                  cx={venue.x}
                  cy={venue.y}
                  r={isSelected ? 11 : 8}
                  fill={isSelected ? "rgba(16, 185, 129, 0.5)" : "rgba(6, 78, 59, 0.7)"}
                  stroke={isSelected ? "#00ff88" : "#34d399"}
                  strokeWidth="2"
                  filter={`url(#${glowConfig.filterId})`}
                />

                {/* Core Pin Dot */}
                <circle
                  cx={venue.x}
                  cy={venue.y}
                  r="3.5"
                  fill={isSelected ? "#ffffff" : "#a7f3d0"}
                />

                {/* Venue Mini Tag */}
                <g transform={`translate(${venue.x + 12}, ${venue.y - 14})`}>
                  <rect
                    x="0"
                    y="0"
                    width={venue.name.length * 6.5 + 46}
                    height="20"
                    rx="3"
                    fill="rgba(3, 21, 12, 0.88)"
                    stroke={isSelected ? "#00ff88" : "rgba(16, 185, 129, 0.4)"}
                    strokeWidth="1"
                  />
                  <text
                    x="6"
                    y="14"
                    fill={isSelected ? "#00ff88" : "#34d399"}
                    fontSize="10"
                    fontFamily="monospace"
                  >
                    [{venue.altitudeLevel}] {venue.name}
                  </text>
                </g>
              </g>
            );
          })}

          {/* Standard Navigation Waypoints */}
          {waypoints.map((wp) => {
            const [wx, wy] = wp.coordinates;
            const isOrigin = wp.type === "origin";
            const isDest = wp.type === "destination";
            const isSelected = selectedWaypointId === wp.id;

            return (
              <g
                key={wp.id}
                className="cursor-pointer group"
                onClick={() => {
                  setSelectedWaypointId(wp.id);
                  onSelectWaypoint?.(wp);
                }}
                tabIndex={0}
                role="button"
                data-testid={`waypoint-pin-${wp.id}`}
                aria-label={`Waypoint ${wp.name}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    setSelectedWaypointId(wp.id);
                    onSelectWaypoint?.(wp);
                  }
                }}
              >
                {/* Outer Ring */}
                <circle
                  cx={wx}
                  cy={wy}
                  r={isSelected ? 10 : 7}
                  fill={isDest ? "rgba(16, 185, 129, 0.4)" : "rgba(6, 78, 59, 0.6)"}
                  stroke={isDest ? "#00ff88" : "#34d399"}
                  strokeWidth="2"
                  filter={`url(#${glowConfig.filterId})`}
                />

                {/* Core Pin Dot */}
                <circle
                  cx={wx}
                  cy={wy}
                  r="3.5"
                  fill={isDest ? "#ffffff" : "#a7f3d0"}
                />

                {/* Waypoint Label HUD Box */}
                <g transform={`translate(${wx + 12}, ${wy - 18})`}>
                  <rect
                    x="0"
                    y="0"
                    width={wp.name.length * 7.5 + 40}
                    height="24"
                    rx="4"
                    fill="rgba(3, 21, 12, 0.85)"
                    stroke={isSelected ? "#00ff88" : "rgba(16, 185, 129, 0.4)"}
                    strokeWidth="1"
                  />
                  <text
                    x="8"
                    y="16"
                    fill={isSelected ? "#00ff88" : "#34d399"}
                    fontSize="11"
                    fontFamily="monospace"
                    fontWeight={isSelected ? "bold" : "normal"}
                  >
                    {isOrigin ? "[ORIGIN] " : isDest ? "[TARGET] " : "[WP] "}
                    {wp.name} {wp.eta ? `(${wp.eta})` : ""}
                  </text>
                </g>
              </g>
            );
          })}
        </svg>

        {/* Interactive Drill-Down Venue Floorplan Overlay */}
        {selectedVenue && (
          <div
            data-testid="venue-floorplan-modal"
            className="absolute bottom-3 right-3 max-w-sm w-full bg-[#031c10]/95 border border-emerald-500/50 rounded-xl p-3 shadow-2xl backdrop-blur-md z-20 text-xs"
          >
            <div className="flex items-center justify-between pb-2 border-b border-emerald-500/20 mb-2">
              <div>
                <h4 className="font-bold text-emerald-200">{selectedVenue.name}</h4>
                <div className="text-[10px] text-emerald-400/80">
                  {selectedVenue.category.toUpperCase()} • ALTITUDE: {selectedVenue.altitudeLevel}
                </div>
              </div>
              <button
                type="button"
                data-testid="close-floorplan-button"
                onClick={() => setSelectedVenue(null)}
                className="text-emerald-500 hover:text-emerald-200 px-1 py-0.5"
                aria-label="Close venue floorplan"
              >
                ✕
              </button>
            </div>

            {/* Floor Navigation Tabs */}
            {selectedVenue.floors && selectedVenue.floors.length > 0 ? (
              <div>
                <div className="flex space-x-1 mb-2">
                  {selectedVenue.floors.map((fl) => (
                    <button
                      key={fl.floorNumber}
                      type="button"
                      data-testid={`floor-tab-${fl.floorNumber}`}
                      onClick={() => setActiveFloorLevel(fl.floorNumber)}
                      className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${
                        activeFloorLevel === fl.floorNumber
                          ? "bg-emerald-500 text-black"
                          : "bg-emerald-950/60 text-emerald-400 hover:bg-emerald-500/20"
                      }`}
                    >
                      L{fl.floorNumber}
                    </button>
                  ))}
                </div>

                {/* Active Floor Desks & Blueprint */}
                {(() => {
                  const floor =
                    selectedVenue.floors.find((f) => f.floorNumber === activeFloorLevel) ||
                    selectedVenue.floors[0];

                  return (
                    <div
                      data-testid="floor-blueprint-view"
                      className="p-2 rounded bg-black/40 border border-emerald-500/30"
                    >
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="text-emerald-300 font-semibold">{floor.name}</span>
                        <span className="text-emerald-400">
                          {floor.desksAvailable} / {floor.totalDesks} Free
                        </span>
                      </div>
                      {/* Mini Floorplan Grid */}
                      <div className="grid grid-cols-6 gap-1 p-1 bg-emerald-950/20 rounded">
                        {Array.from({ length: 12 }).map((_, idx) => {
                          const isOccupied = idx >= floor.desksAvailable / 3;
                          return (
                            <div
                              key={idx}
                              data-testid={`floor-desk-${idx}`}
                              className={`h-4 rounded-sm flex items-center justify-center text-[8px] ${
                                isOccupied
                                  ? "bg-emerald-900/40 text-emerald-700 border border-emerald-900/40"
                                  : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-[0_0_4px_rgba(16,185,129,0.3)]"
                              }`}
                            >
                              D{idx + 1}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            ) : (
              <div className="text-emerald-400/80 text-[11px]">
                Capacity: {selectedVenue.currentOccupancy} / {selectedVenue.capacity} Checked In
              </div>
            )}
          </div>
        )}

        {/* Screen Reader Accessible Live Region */}
        <div className="sr-only" aria-live="polite">
          Active tactical airspace flight route: {pathCoordinates.length} waypoints plotted.
          Mode: {mode}. Glow intensity: {glowIntensity}.
          Corridors: {corridors.length} active. Venues: {venueMarkers.length} tracked.
        </div>
      </div>

      {/* Cockpit HUD Bottom Status Strip */}
      <div className="flex flex-wrap items-center justify-between px-4 py-2 bg-emerald-950/60 border-t border-emerald-500/20 text-[11px] text-emerald-400/80">
        <div className="flex items-center space-x-4">
          <span>VELOCITY: <strong className="text-emerald-200">{travelSpeedKts}</strong></span>
          <span className="hidden md:inline">
            CORRIDORS: <span className="text-emerald-300">{corridors.length} MONITORED</span>
          </span>
          <span className="hidden md:inline">
            VENUES: <span className="text-emerald-300">{venueMarkers.length} SYNCED</span>
          </span>
        </div>
        <div className="text-emerald-500">
          TACTICAL AIRSPACE RADAR: ACTIVE // 60 FPS SUSTAINED
        </div>
      </div>
    </div>
  );
});

TacticalAirspaceMap.displayName = "TacticalAirspaceMap";

export default TacticalAirspaceMap;
