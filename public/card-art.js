import { hashText } from "./card-logic.js";

// Shared by the reader's card preview (browser) and card-renderer.js (SVG/PNG export),
// so a card looks the same in both places.

function seededRandom(seed) {
  let value = (Number(seed) || 1) >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

/**
 * Background art for a ritual card as SVG markup for a width x height box. Everything is
 * drawn in currentColor, so the surrounding SVG/CSS decides the ink colour.
 */
export function cardArtSvg(card, width, height) {
  const random = seededRandom(card.artSeed || hashText(`${card.id}:${card.quote}:${card.note}`));
  if (card.art === "lastfold" || (card.scope || card.context?.scope) === "book") {
    const density = Array.isArray(card.context?.density) ? card.context.density.map((value) => Number(value) || 0) : [];
    const max = Math.max(...density, 1);
    const points = density.length ? density : Array.from({ length: 18 }, () => Math.floor(random() * 3));
    const left = width * 0.15;
    const right = width * 0.86;
    const base = height * 0.34;
    const amplitude = height * 0.09;
    const pathLine = points.map((value, index) => {
      const x = left + (right - left) * (points.length <= 1 ? 0 : index / (points.length - 1));
      const y = base - (value / max) * amplitude + (random() - 0.5) * 5;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
    const spineX = width * (0.82 + random() * 0.05);
    const spine = `<path d="M ${spineX.toFixed(1)} 34 C ${(spineX - 8).toFixed(1)} ${(height * 0.36).toFixed(1)} ${(spineX + 7).toFixed(1)} ${(height * 0.7).toFixed(1)} ${spineX.toFixed(1)} ${(height - 34).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.11"/>`;
    const quietLines = Array.from({ length: 8 }, () => {
      const x = 44 + random() * (width - 88);
      return `<path d="M ${x.toFixed(1)} 40 L ${(x + (random() - 0.5) * 16).toFixed(1)} ${(height - 46).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="0.55" opacity="${(0.035 + random() * 0.07).toFixed(3)}"/>`;
    }).join("");
    const wave = `<path d="${pathLine}" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" opacity="0.24"/>`;
    return `${quietLines}${spine}<line x1="${(width * 0.13).toFixed(1)}" y1="${(height * 0.52).toFixed(1)}" x2="${(width * 0.87).toFixed(1)}" y2="${(height * 0.52).toFixed(1)}" stroke="currentColor" stroke-width="0.7" opacity="0.10"/>${wave}`;
  }
  if (card.art === "ripple") {
    const centers = [
      [width * (0.24 + random() * 0.1), height * (0.2 + random() * 0.08)],
      [width * (0.56 + random() * 0.12), height * (0.42 + random() * 0.12)],
      [width * (0.2 + random() * 0.08), height * (0.68 + random() * 0.08)],
    ];
    return centers
      .flatMap(([cx, cy], groupIndex) =>
        Array.from({ length: groupIndex === 1 ? 4 : 3 }, (_, index) => {
          const radius = 34 + index * (30 + random() * 16) + random() * 10;
          const opacity = 0.035 + random() * 0.055;
          return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.2" opacity="${opacity.toFixed(3)}"/>`;
        }),
      )
      .join("");
  }
  if (card.art === "stardust") {
    const dots = Array.from({ length: 72 }, () => {
      const cx = 28 + random() * (width - 56);
      const cy = 38 + random() * (height - 90);
      const radius = 0.35 + random() * 0.95;
      const opacity = 0.16 + random() * 0.38;
      return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(2)}" fill="currentColor" opacity="${opacity.toFixed(3)}"/>`;
    }).join("");
    const crosses = Array.from({ length: 7 }, () => {
      const cx = 48 + random() * (width - 96);
      const cy = 58 + random() * (height - 116);
      const opacity = 0.18 + random() * 0.22;
      return `<path d="M ${(cx - 3).toFixed(1)} ${cy.toFixed(1)} L ${(cx + 3).toFixed(1)} ${cy.toFixed(1)} M ${cx.toFixed(1)} ${(cy - 3).toFixed(1)} L ${cx.toFixed(1)} ${(cy + 3).toFixed(1)}" stroke="currentColor" stroke-width="0.7" opacity="${opacity.toFixed(3)}"/>`;
    }).join("");
    return `${dots}${crosses}`;
  }
  return Array.from({ length: 16 }, () => {
    const x = 34 + random() * (width - 68);
    const drift = (random() - 0.5) * 34;
    const opacity = 0.045 + random() * 0.1;
    return `<path d="M ${x.toFixed(1)} 18 C ${(x + drift).toFixed(1)} ${(height * 0.32).toFixed(1)} ${(x - drift).toFixed(1)} ${(height * 0.68).toFixed(1)} ${x.toFixed(1)} ${(height - 18).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="0.9" opacity="${opacity.toFixed(3)}"/>`;
  }).join("");
}

