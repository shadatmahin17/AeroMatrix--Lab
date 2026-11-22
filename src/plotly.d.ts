declare module "plotly.js-basic-dist-min" {
  const Plotly: {
    react: (
      root: HTMLElement,
      data: Array<Record<string, unknown>>,
      layout?: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<HTMLElement>;
    toImage: (
      figure: { data: Array<Record<string, unknown>>; layout: Record<string, unknown> },
      opts: { format: "png" | "svg" | "jpeg" | "webp"; width: number; height: number; scale?: number }
    ) => Promise<string>;
    purge: (root: HTMLElement) => void;
    Plots: {
      resize: (root: HTMLElement) => void;
    };
  };
  export default Plotly;
}
