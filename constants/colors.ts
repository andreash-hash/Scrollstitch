/**
 * Modernist — ported from the Claude Design system bundle.
 *
 * A light, high-contrast ground with a single hot accent, square corners and
 * heavy 2px rules. `dark` keeps its name so every existing `Colors.dark`
 * import keeps working; the palette underneath is the light one.
 */
const Colors = {
  dark: {
    background: "#f3f2f2",
    surface: "#eae9e9",
    surfaceElevated: "#eae7e7",

    accent: "#ec3013",
    accentStrong: "#dd2b0f",
    accentPressed: "#ae1800",
    // Tints used for tags and fills that sit under text
    accentMuted: "#fff2ef",
    accentDim: "#7c1405",

    text: "#201e1d",
    textSecondary: "rgba(32, 30, 29, 0.65)",
    textTertiary: "rgba(32, 30, 29, 0.5)",
    /** 2px rules and input borders — the system's structural line. */
    border: "rgba(32, 30, 29, 0.4)",

    neutral100: "#f8f4f4",
    neutral200: "#eae7e7",
    neutral300: "#d7d3d3",
    neutral400: "#bab6b6",
    neutral500: "#9b9797",
    neutral600: "#7d7979",
    neutral700: "#605d5d",
    neutral800: "#444141",
    neutral900: "#2d2b2b",

    danger: "#ae1800",
    warning: "#c94b39",
    success: "#ec3013",
    tint: "#ec3013",
    tabIconDefault: "#7d7979",
    tabIconSelected: "#ec3013",

    /** Text and icons that sit on top of an accent fill. */
    onAccent: "#f3f2f2",
  },
};

/** Type ramp and spacing, mirroring the design system's scale. */
export const Type = {
  h1: 34,
  h2: 30,
  h3: 25,
  h4: 20,
  body: 15,
  bodySm: 14,
  label: 12,
  micro: 10,
  regular: "Archivo_400Regular",
  medium: "Archivo_600SemiBold",
  semibold: "Archivo_600SemiBold",
  bold: "Archivo_800ExtraBold",
} as const;

export const Space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
} as const;

export default Colors;
