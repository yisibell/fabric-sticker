<template>
  <div class="canvas-container">
    <canvas ref="canvasRef"></canvas>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Canvas,
  FabricImage,
  Path,
  Point,
  Polygon,
  Rect,
  Textbox,
  type FabricObject,
  type TDataUrlOptions,
} from 'fabric';

type StickerType = 'image' | 'text';

interface StickerPoint {
  x: number;
  y: number;
}

interface StickerRectArea {
  left: number;
  top: number;
  width: number;
  height: number;
  type?: 'rect';
}

interface StickerPolygonArea {
  type: 'polygon';
  points: StickerPoint[];
}

interface StickerPathArea {
  type: 'path';
  path: string;
}

type StickerArea = StickerRectArea | StickerPolygonArea | StickerPathArea;

interface StickerBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface StickerTextOptions {
  fill?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string | number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
}

interface Props {
  width?: number;
  height?: number;
  bgImg: string;
  stickerArea?: StickerArea;
  stickerImg?: string;
  stickerText?: string;
  stickerType?: StickerType;
  stickerTextOptions?: StickerTextOptions;
  showStickerBounds?: boolean;
}

type ExportOptions = Partial<
  Pick<TDataUrlOptions, 'format' | 'quality' | 'multiplier' | 'enableRetinaScaling'>
>;

interface StickerState {
  type?: StickerType;
  imageUrl: string;
  text: string;
  textOptions?: StickerTextOptions;
}

const props = withDefaults(defineProps<Props>(), {
  width: 400,
  height: 554,
  stickerImg: '',
  stickerText: '',
  showStickerBounds: true,
});

const canvasRef = ref<HTMLCanvasElement | null>(null);

let canvas: Canvas | null = null;
let stickerObject: FabricObject | null = null;
let stickerClipPath: FabricObject | null = null;
let stickerGuideShape: FabricObject | null = null;
let stickerPathHitRegion: Path2D | null = null;
let stickerLastValidCenter: Point | null = null;
let initId = 0;
let stickerLoadId = 0;
let bgAbortController: AbortController | null = null;
let stickerAbortController: AbortController | null = null;

const stickerState = ref<StickerState>({
  type: props.stickerType,
  imageUrl: props.stickerImg,
  text: props.stickerText,
  textOptions: props.stickerTextOptions,
});

const getStickerArea = (): StickerArea => {
  return props.stickerArea ?? {
    left: 0,
    top: 0,
    width: props.width,
    height: props.height,
  };
};

const isRectArea = (area: StickerArea): area is StickerRectArea => {
  return !area.type || area.type === 'rect';
};

const isPointInPolygon = (point: Point, points: StickerPoint[]) => {
  if (points.length < 3) return false;

  let inside = false;

  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const current = points[i]!;
    const previous = points[j]!;
    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x;

    if (intersects) inside = !inside;
  }

  return inside;
};

const getPointsBounds = (points: StickerPoint[]): StickerBounds => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
};

const getStickerBounds = (): StickerBounds => {
  const area = getStickerArea();

  if (isRectArea(area)) {
    return {
      left: area.left,
      top: area.top,
      width: area.width,
      height: area.height,
    };
  }

  if (area.type === 'polygon') {
    return getPointsBounds(area.points);
  }

  const path = new Path(area.path);
  path.setCoords();
  return path.getBoundingRect();
};

const isPointInStickerArea = (point: Point) => {
  const area = getStickerArea();

  if (isRectArea(area)) {
    return (
      point.x >= area.left &&
      point.x <= area.left + area.width &&
      point.y >= area.top &&
      point.y <= area.top + area.height
    );
  }

  if (area.type === 'polygon') {
    return isPointInPolygon(point, area.points);
  }

  const context = canvasRef.value?.getContext('2d');
  if (!context || !stickerPathHitRegion) return true;

  return context.isPointInPath(stickerPathHitRegion, point.x, point.y);
};

const getAreaCenterPoint = () => {
  const bounds = getStickerBounds();
  const center = new Point(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);

  if (isPointInStickerArea(center)) return center;

  const area = getStickerArea();
  if (area.type === 'polygon' && area.points.length) {
    const average = area.points.reduce(
      (point, current) => new Point(point.x + current.x, point.y + current.y),
      new Point(0, 0),
    );
    const centroid = new Point(
      average.x / area.points.length,
      average.y / area.points.length,
    );

    if (isPointInStickerArea(centroid)) return centroid;
  }

  const steps = 24;
  for (let row = 0; row <= steps; row++) {
    for (let column = 0; column <= steps; column++) {
      const candidate = new Point(
        bounds.left + (bounds.width * column) / steps,
        bounds.top + (bounds.height * row) / steps,
      );

      if (isPointInStickerArea(candidate)) return candidate;
    }
  }

  return center;
};

const getStickerType = (): StickerType => {
  if (stickerState.value.type) return stickerState.value.type;
  return stickerState.value.text && !stickerState.value.imageUrl ? 'text' : 'image';
};

// Cover the configured canvas without letterboxing when the product image ratio differs.
const fitBackgroundToCanvas = (image: FabricImage) => {
  const scale = Math.max(props.width / image.width, props.height / image.height);

  image.set({
    originX: 'center',
    originY: 'center',
    left: props.width / 2,
    top: props.height / 2,
    scaleX: scale,
    scaleY: scale,
  });
};

const createAreaShape = (guide: boolean): FabricObject => {
  const area = getStickerArea();
  const commonOptions = {
    fill: guide ? 'rgba(37, 99, 235, 0.08)' : '#000',
    stroke: guide ? '#2563eb' : undefined,
    strokeWidth: guide ? 1 : 0,
    strokeDashArray: guide ? [6, 4] : undefined,
    selectable: false,
    evented: false,
    visible: guide ? props.showStickerBounds : true,
    excludeFromExport: guide,
  };

  let shape: FabricObject;

  if (isRectArea(area)) {
    shape = new Rect({
      originX: 'left',
      originY: 'top',
      left: area.left,
      top: area.top,
      width: area.width,
      height: area.height,
      ...commonOptions,
    });
  } else if (area.type === 'polygon') {
    shape = new Polygon(area.points, {
      ...commonOptions,
    });
  } else {
    shape = new Path(area.path, {
      ...commonOptions,
    });
  }

  shape.set({
    absolutePositioned: !guide,
  });
  shape.setCoords();

  return shape;
};

// The real clip path for sticker rendering. It is not added to the canvas object stack.
const createClipPath = () => {
  stickerPathHitRegion = null;

  const area = getStickerArea();
  if (area.type === 'path') {
    stickerPathHitRegion = new Path2D(area.path);
  }

  return createAreaShape(false);
};

// Visual guide for the configured sticker area. It is filtered out during export.
const createGuideShape = () => {
  return createAreaShape(true);
};

// Start stickers from the area center; drag math also relies on a center origin.
const setObjectCenter = (object: FabricObject) => {
  const center = getAreaCenterPoint();

  object.set({
    originX: 'center',
    originY: 'center',
  });
  object.setPositionByOrigin(center, 'center', 'center');
  stickerLastValidCenter = center;
  object.setCoords();
};

// Make the sticker cover the area initially so dragging changes the clipped content.
const fitObjectToCoverSticker = (object: FabricObject) => {
  const { width, height } = getStickerBounds();
  const objectWidth = object.getScaledWidth();
  const objectHeight = object.getScaledHeight();

  if (!objectWidth || !objectHeight) return;

  const scale = Math.max(width / objectWidth, height / objectHeight);

  object.scaleX = (object.scaleX || 1) * scale;
  object.scaleY = (object.scaleY || 1) * scale;
  object.setCoords();
};

// Keep only the sticker center inside the area. clipPath handles visible clipping.
const constrainObjectCenterToStickerArea = (object: FabricObject) => {
  const center = new Point(object.left ?? 0, object.top ?? 0);

  if (isPointInStickerArea(center)) {
    stickerLastValidCenter = center;
  } else if (stickerLastValidCenter) {
    object.setPositionByOrigin(stickerLastValidCenter, 'center', 'center');
  } else {
    setObjectCenter(object);
  }

  object.setCoords();
};

const removeStickerObject = () => {
  if (canvas && stickerObject) {
    canvas.remove(stickerObject);
  }
  stickerObject = null;
};

const applyStickerObject = (object: FabricObject) => {
  if (!canvas || !stickerClipPath) return;

  removeStickerObject();

  object.set({
    // absolutePositioned makes clipPath use canvas coordinates instead of object-local coordinates.
    clipPath: stickerClipPath,
    cornerStyle: 'circle',
    transparentCorners: false,
  });

  fitObjectToCoverSticker(object);
  setObjectCenter(object);
  constrainObjectCenterToStickerArea(object);

  stickerObject = object;
  canvas.add(object);
  canvas.setActiveObject(object);
  canvas.requestRenderAll();
};

const loadImageSticker = async (url: string) => {
  if (!url) {
    removeStickerObject();
    canvas?.requestRenderAll();
    return;
  }

  const loadId = ++stickerLoadId;
  stickerAbortController?.abort();
  stickerAbortController = new AbortController();

  try {
    // Abort older loads and check loadId so stale image requests cannot replace newer stickers.
    const image = await FabricImage.fromURL(url, {
      crossOrigin: 'anonymous',
      signal: stickerAbortController.signal,
    });

    if (!canvas || loadId !== stickerLoadId) return;

    image.set({
      lockScalingFlip: true,
    });
    image.setControlsVisibility({
      mt: false,
      mb: false,
      ml: false,
      mr: false,
      bl: true,
      br: true,
      tl: true,
      tr: true,
      mtr: true,
    });

    applyStickerObject(image);
  } catch (error) {
    if (!stickerAbortController.signal.aborted) {
      console.error('Sticker image load failed:', error);
    }
  }
};

const createTextSticker = () => {
  const text = stickerState.value.text?.trim();

  if (!text) {
    removeStickerObject();
    canvas?.requestRenderAll();
    return;
  }

  const { width, height } = getStickerBounds();
  const options = stickerState.value.textOptions;
  const fontSize = options?.fontSize ?? Math.max(14, Math.min(36, height * 0.22));

  // Textbox wraps content, so it fits configured rectangular areas better than FabricText.
  const textbox = new Textbox(text, {
    width: width * 0.8,
    fill: options?.fill ?? '#111827',
    fontFamily: options?.fontFamily ?? 'Arial',
    fontSize,
    fontWeight: options?.fontWeight ?? 'normal',
    textAlign: options?.textAlign ?? 'center',
    splitByGrapheme: true,
    lockScalingFlip: true,
  });

  applyStickerObject(textbox);
};

const applySticker = async () => {
  if (!canvas || !stickerClipPath) return;

  if (getStickerType() === 'text') {
    stickerAbortController?.abort();
    createTextSticker();
    return;
  }

  await loadImageSticker(stickerState.value.imageUrl);
};

const updateStickerArea = async () => {
  if (!canvas) return;

  const oldGuideShape = stickerGuideShape;
  const oldStickerObject = stickerObject;

  stickerClipPath = createClipPath();
  stickerGuideShape = createGuideShape();

  if (oldGuideShape) {
    canvas.remove(oldGuideShape);
  }
  canvas.insertAt(0, stickerGuideShape);

  if (oldStickerObject) {
    // Area changes need a fresh clipPath and a re-fit of the current sticker.
    oldStickerObject.set({ clipPath: stickerClipPath });
    setObjectCenter(oldStickerObject);
    fitObjectToCoverSticker(oldStickerObject);
    constrainObjectCenterToStickerArea(oldStickerObject);
  }

  canvas.requestRenderAll();
};

const disposeCanvas = async () => {
  bgAbortController?.abort();
  stickerAbortController?.abort();
  bgAbortController = null;
  stickerAbortController = null;
  stickerObject = null;
  stickerClipPath = null;
  stickerGuideShape = null;
  stickerPathHitRegion = null;
  stickerLastValidCenter = null;

  if (!canvas) return;

  const currentCanvas = canvas;
  canvas = null;
  await currentCanvas.dispose().catch((error) => {
    console.error('Canvas dispose failed:', error);
  });
};

const initCanvas = async () => {
  if (!canvasRef.value) return;

  const currentInitId = ++initId;
  await disposeCanvas();

  bgAbortController = new AbortController();

  try {
    const bgImage = await FabricImage.fromURL(props.bgImg, {
      crossOrigin: 'anonymous',
      signal: bgAbortController.signal,
    });

    // Background loading is async; initId prevents stale init results from replacing newer props.
    if (!canvasRef.value || currentInitId !== initId) return;

    const nextCanvas = new Canvas(canvasRef.value, {
      width: props.width,
      height: props.height,
      preserveObjectStacking: true,
      selection: false,
    });

    fitBackgroundToCanvas(bgImage);
    bgImage.set({
      selectable: false,
      evented: false,
      hasControls: false,
      hoverCursor: 'default',
    });
    bgImage.canvas = nextCanvas;
    nextCanvas.backgroundImage = bgImage;

    canvas = nextCanvas;
    stickerClipPath = createClipPath();
    stickerGuideShape = createGuideShape();
    // Keep the guide at the bottom so it cannot block sticker interaction.
    canvas.insertAt(0, stickerGuideShape);

    canvas.on('object:moving', (event) => {
      if (event.target === stickerObject) {
        constrainObjectCenterToStickerArea(event.target);
      }
    });
    canvas.on('object:scaling', (event) => {
      if (event.target === stickerObject) {
        constrainObjectCenterToStickerArea(event.target);
      }
    });
    canvas.on('object:rotating', (event) => {
      if (event.target === stickerObject) {
        constrainObjectCenterToStickerArea(event.target);
      }
    });

    await applySticker();
    canvas.requestRenderAll();
  } catch (error) {
    if (!bgAbortController?.signal.aborted) {
      console.error('Canvas init failed:', error);
    }
  }
};

const getCombinedImage = async (options: ExportOptions = {}): Promise<string | null> => {
  if (!canvas) return null;

  canvas.discardActiveObject();
  canvas.renderAll();

  try {
    return canvas.toDataURL({
      format: options.format ?? 'png',
      quality: options.quality ?? 1,
      multiplier: options.multiplier ?? 1,
      enableRetinaScaling: options.enableRetinaScaling ?? false,
      // Export only the product image and sticker/text, not the editing guide.
      filter: (object) => object !== stickerGuideShape,
    });
  } catch (error) {
    console.error('Canvas export failed:', error);
    return null;
  }
};

const setStickerImage = async (url: string) => {
  stickerState.value = {
    type: 'image',
    imageUrl: url,
    text: '',
    textOptions: undefined,
  };
  await loadImageSticker(url);
};

const setStickerText = (text: string, options?: StickerTextOptions) => {
  stickerState.value = {
    type: 'text',
    imageUrl: '',
    text,
    textOptions: options,
  };

  const { width, height } = getStickerBounds();
  const fontSize = options?.fontSize ?? Math.max(14, Math.min(36, height * 0.22));

  const textbox = new Textbox(text, {
    width: width * 0.8,
    fill: options?.fill ?? '#111827',
    fontFamily: options?.fontFamily ?? 'Arial',
    fontSize,
    fontWeight: options?.fontWeight ?? 'normal',
    textAlign: options?.textAlign ?? 'center',
    splitByGrapheme: true,
    lockScalingFlip: true,
  });

  applyStickerObject(textbox);
};

watch(
  () => [props.bgImg, props.width, props.height],
  () => {
    void initCanvas();
  },
);

watch(
  () => getStickerBounds(),
  () => {
    void updateStickerArea();
  },
);

watch(
  () => [props.stickerType, props.stickerImg, props.stickerText, props.stickerTextOptions],
  () => {
    stickerState.value = {
      type: props.stickerType,
      imageUrl: props.stickerImg,
      text: props.stickerText,
      textOptions: props.stickerTextOptions,
    };
    void applySticker();
  },
  { deep: true },
);

watch(
  () => props.showStickerBounds,
  (visible) => {
    if (stickerGuideShape) {
      stickerGuideShape.visible = visible;
      canvas?.requestRenderAll();
    }
  },
);

onMounted(() => {
  void initCanvas();
});

onBeforeUnmount(() => {
  void disposeCanvas();
});

defineExpose({
  getCombinedImage,
  setStickerImage,
  setStickerText,
});
</script>

<style scoped>
.canvas-container {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}
</style>
