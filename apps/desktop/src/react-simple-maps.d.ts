declare module 'react-simple-maps' {
  import type { ComponentType, CSSProperties, MouseEvent, ReactNode } from 'react';

  export interface ComposableMapProps {
    projection?: string;
    projectionConfig?: Record<string, unknown>;
    style?: CSSProperties;
    children?: ReactNode;
  }

  export interface GeographiesProps {
    geography: string | Record<string, unknown>;
    children: (props: { geographies: GeographyRecord[] }) => ReactNode;
  }

  export interface GeographyRecord {
    rsmKey: string;
    id: number;
    properties: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface GeographyProps {
    key?: string;
    geography: GeographyRecord;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    style?: {
      default?: CSSProperties;
      hover?: CSSProperties & { cursor?: string; outline?: string };
      pressed?: CSSProperties;
    };
    onClick?: (event: MouseEvent<SVGPathElement>) => void;
    onMouseEnter?: (event: MouseEvent<SVGPathElement>) => void;
    onMouseLeave?: (event: MouseEvent<SVGPathElement>) => void;
  }

  export interface MarkerProps {
    key?: string;
    coordinates: [number, number];
    children?: ReactNode;
  }

  export interface ZoomableGroupProps {
    zoom?: number;
    minZoom?: number;
    maxZoom?: number;
    center?: [number, number];
    onMoveEnd?: (pos: { zoom: number; coordinates: [number, number] }) => void;
    children?: ReactNode;
  }

  export const ComposableMap: ComponentType<ComposableMapProps>;
  export const Geographies: ComponentType<GeographiesProps>;
  export const Geography: ComponentType<GeographyProps>;
  export const Marker: ComponentType<MarkerProps>;
  export const ZoomableGroup: ComponentType<ZoomableGroupProps>;
}
