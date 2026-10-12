import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, ArrowRight, Droplets } from "lucide-react";
import { aelune } from "@/content/aelune";
import "./brand.css";

export const metadata: Metadata = {
  title: "AELUNE · The design direction",
  description: "An editable style tile for the AELUNE beauty kiosk concept.",
};

const palette = [
  { name: "Ice", value: "#EAF5FB", className: "ice" },
  { name: "Ink", value: "#11262F", className: "ink" },
  { name: "Paper", value: "#F7F8F5", className: "milk" },
  { name: "Mist", value: "#CDDDE4", className: "mist" },
] as const;

export default function BrandDirectionPage() {
  return (
    <main className="brand-tile">
      <header className="brand-tile-header">
        <Link className="brand-tile-logo" href="/" aria-label="AELUNE home">
          <Image
            src="/brand/aelune-wordmark.svg"
            alt="AELUNE"
            width={340}
            height={64}
            loading="eager"
            unoptimized
          />
        </Link>
        <Link className="brand-tile-text-link" href="/">
          View the website <ArrowUpRight size={17} aria-hidden="true" />
        </Link>
      </header>

      <section className="brand-tile-intro" aria-labelledby="direction-title">
        <span className="brand-tile-kicker">THE DESIGN DIRECTION / 01</span>
        <h1 id="direction-title">
          Beauty, seen <em>differently.</em>
        </h1>
        <p>
          AELUNE brings a quiet, luminous identity to in-store beauty discovery.
          Water is the visual thread. Clarity is the design principle.
        </p>
        <span className="brand-tile-note">
          Working brand concept · Editable style tile, not a finished product
          screen
        </span>
      </section>

      <div className="brand-tile-grid">
        <section
          className="brand-tile-panel brand-tile-identity"
          aria-labelledby="identity-title"
        >
          <h2 id="identity-title">01 / The signature</h2>
          <div className="brand-tile-signature">
            <Image
              src="/brand/aelune-wordmark.svg"
              alt="Selected AELUNE wordmark"
              width={340}
              height={64}
              unoptimized
            />
            <span>BEAUTY, SEEN DIFFERENTLY.</span>
          </div>
          <p>
            Generous spacing. A precise silhouette. An identity that gives the
            story room to breathe.
          </p>
          <a
            className="brand-tile-text-link"
            href="/brand/aelune-wordmark.svg"
            download
          >
            Download editable SVG <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </section>

        <section className="brand-tile-panel" aria-labelledby="palette-title">
          <h2 id="palette-title">02 / The palette</h2>
          <div className="brand-tile-palette">
            {palette.map((color) => (
              <div className="brand-tile-color" key={color.name}>
                <span
                  className={`brand-tile-swatch brand-tile-swatch-${color.className}`}
                />
                <strong>{color.name}</strong>
                <code>{color.value}</code>
              </div>
            ))}
          </div>
          <p>
            Ice for atmosphere, ink for readable decisions. Paper and mist keep
            surfaces soft without hiding their edges.
          </p>
        </section>

        <section
          className="brand-tile-panel brand-tile-type"
          aria-labelledby="type-title"
        >
          <h2 id="type-title">03 / The typography</h2>
          <p className="brand-tile-type-display">
            A little closer.
            <br />
            <em>A little clearer.</em>
          </p>
          <p className="brand-tile-type-label">GEORGIA / EDITORIAL DISPLAY</p>
          <p className="brand-tile-type-body">
            Explore your colors. Discover your styling possibilities. Find
            matching shades available in your store.
          </p>
          <p className="brand-tile-type-label">ARIAL / INTERFACE &amp; BODY</p>
          <p>
            Local font stacks keep the experience independent of a font service.
            Large headlines meet calm, practical interface text.
          </p>
        </section>

        <section
          className="brand-tile-panel"
          aria-labelledby="interaction-title"
        >
          <h2 id="interaction-title">04 / The interactions</h2>
          <div className="brand-tile-actions">
            <Link
              className="brand-tile-button brand-tile-primary"
              href="/kiosk"
            >
              Find your beauty direction{" "}
              <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
            <Link
              className="brand-tile-button brand-tile-secondary"
              href="/management"
            >
              Store workspace <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <Link className="brand-tile-text-link" href="/#how-it-works">
              How it works <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          </div>
          <p>
            One clear action at a time. At least 48px touch targets. Visible
            keyboard focus. Motion follows the visitor, with an easy way to
            skip.
          </p>
        </section>

        <section className="brand-tile-panel" aria-labelledby="component-title">
          <h2 id="component-title">05 / The component language</h2>
          <article className="brand-tile-ingredient">
            <div className="brand-tile-ingredient-icon">
              <Droplets size={25} aria-hidden="true" />
            </div>
            <span className="brand-tile-type-label">
              ILLUSTRATIVE PALETTE CARD
            </span>
            <h3>Soft rose</h3>
            <p>
              A gentle color direction to compare in makeup, hair accents and
              the details you love.
            </p>
            <span className="brand-tile-ingredient-footnote">
              Optional photo suggestion → confirmed palette → registered lip
              shades
            </span>
          </article>
          <p>
            Names and reasons stay readable. Real store availability belongs to
            the live result screen; this sample makes no stock or suitability
            claim.
          </p>
        </section>

        <section
          className="brand-tile-panel brand-tile-imagery"
          aria-labelledby="imagery-title"
        >
          <h2 id="imagery-title">06 / The imagery</h2>
          <div className="brand-tile-image">
            <Image
              src={aelune.media.drop}
              alt="A luminous crystal-clear droplet in an ice-blue environment, the opening visual direction for Inside the Drop"
              fill
              sizes="(max-width: 700px) 90vw, 45vw"
              unoptimized
            />
          </div>
          <p>
            Macro water, translucent forms and natural-looking skin. The CGI
            film is a promotional metaphor; the actual kiosk describes visible
            appearance.
          </p>
        </section>
      </div>

      <section className="brand-tile-film" aria-labelledby="film-title">
        <div className="brand-tile-film-copy">
          <span className="brand-tile-kicker">
            THE ORIGINAL FILM / CREATIVE SOURCES
          </span>
          <h2 id="film-title">Inside the Drop.</h2>
          <p>
            A cinematic journey from one drop to a new perspective on skin. Play
            the selected Higgsfield concept film here, or keep the original
            assets for your next creative chapter.
          </p>
          <p className="brand-tile-film-note">
            Promotional CGI imagery. The film plays only when you choose.
          </p>
          <div
            className="brand-tile-source-links"
            aria-label="Creative source downloads"
          >
            <a
              className="brand-tile-text-link"
              href={aelune.media.film}
              download
            >
              Original film <ArrowUpRight size={16} aria-hidden="true" />
            </a>
            <a
              className="brand-tile-text-link"
              href="/brand/aelune-wordmark.svg"
              download
            >
              Wordmark SVG <ArrowUpRight size={16} aria-hidden="true" />
            </a>
            <a
              className="brand-tile-text-link"
              href="/brand/aelune-mark.svg"
              download
            >
              Symbol SVG <ArrowUpRight size={16} aria-hidden="true" />
            </a>
            <a
              className="brand-tile-text-link"
              href="/brand/aelune-concepts.png"
              download
            >
              Logo concepts <ArrowUpRight size={16} aria-hidden="true" />
            </a>
            <a
              className="brand-tile-text-link"
              href="/media/aelune/drop-source.png"
              download
            >
              Droplet still <ArrowUpRight size={16} aria-hidden="true" />
            </a>
            <a
              className="brand-tile-text-link"
              href="/media/aelune/skin-source.png"
              download
            >
              Editorial still <ArrowUpRight size={16} aria-hidden="true" />
            </a>
          </div>
        </div>
        <video
          controls
          muted
          playsInline
          preload="none"
          poster={aelune.media.drop}
          width={1080}
          height={1920}
          aria-label="Inside the Drop original concept film"
        >
          <source src={aelune.media.filmPreview} type="video/mp4" />
          Your browser does not support video playback. Use the original film
          link.
        </video>
      </section>

      <footer className="brand-tile-footer">
        <p>
          Built to be edited. Website copy and media live in the project; this
          page is its compact visual reference.
        </p>
        <Link className="brand-tile-text-link" href="/">
          Return to AELUNE <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
      </footer>
    </main>
  );
}
