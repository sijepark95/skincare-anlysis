import Link from "next/link";
import Image from "next/image";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  Circle,
  Layers3,
  Monitor,
  Plus,
  ScanFace,
  ShieldCheck,
  Store,
} from "lucide-react";
import { aelune } from "@/content/aelune";
import { Brand } from "@/ui/brand";
import { ScrollStory } from "@/ui/scroll-story";
import "./aelune-landing.css";

export function AeluneLanding() {
  const [discoveryLine, discoveryEmphasis] = aelune.discovery.title.split("\n");
  const [retailerLine, retailerEmphasis] = aelune.retailer.title.split("\n");
  return (
    <main className="aelune" id="top">
      <a className="aelune-skip" href="#how-it-works">
        Skip to how it works
      </a>
      <header className="aelune-header">
        <Brand />
        <nav aria-label="Main navigation">
          {aelune.navigation.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
        <Link className="aelune-header-login" href={aelune.links.signin}>
          Store sign in <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </header>

      <section className="aelune-hero" aria-labelledby="aelune-hero-title">
        <div className="aelune-hero-image" aria-hidden="true">
          <Image
            src={aelune.media.drop}
            alt=""
            fill
            loading="eager"
            sizes="100vw"
          />
        </div>
        <div className="aelune-hero-copy">
          <span className="aelune-eyebrow">
            <span className="aelune-tiny-orbit" aria-hidden="true" />
            {aelune.hero.eyebrow}
          </span>
          <h1 id="aelune-hero-title">
            {aelune.hero.firstLine}
            <br />
            <em>{aelune.hero.secondLine}</em>
          </h1>
          <p>{aelune.hero.description}</p>
          <div className="aelune-hero-actions">
            <Link className="aelune-button" href={aelune.links.kiosk}>
              {aelune.hero.primary}
              <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
            <a className="aelune-text-link" href="#experience">
              {aelune.hero.secondary}
              <ArrowDown size={16} aria-hidden="true" />
            </a>
          </div>
        </div>
        <div className="aelune-hero-bottom">
          <span>{aelune.tagline}</span>
          <a href="#experience">
            SCROLL TO EXPLORE <ArrowDown size={13} aria-hidden="true" />
          </a>
          <span className="aelune-hero-edition">
            BEAUTY / HUMAN / TECHNOLOGY
          </span>
        </div>
      </section>

      <ScrollStory />

      <section
        className="aelune-discovery aelune-section"
        id="how-it-works"
        aria-labelledby="discovery-title"
      >
        <div className="aelune-discovery-intro">
          <span className="aelune-eyebrow">{aelune.discovery.eyebrow}</span>
          <h2 id="discovery-title">
            {discoveryLine}
            <br />
            <em>{discoveryEmphasis}</em>
          </h2>
          <p>{aelune.discovery.description}</p>
        </div>
        <div className="aelune-discovery-body">
          <figure className="aelune-skin-portrait">
            <Image
              src={aelune.media.skin}
              alt="Editorial beauty portrait with natural skin texture in soft blue light"
              fill
              sizes="(max-width: 700px) 100vw, 46vw"
            />
            <div className="aelune-portrait-note">
              <span className="aelune-orbit" aria-hidden="true" />
              <span>
                A closer look.
                <br />
                <em>A personal perspective.</em>
              </span>
            </div>
            <figcaption>
              AI-generated editorial imagery · Not an analysis result
            </figcaption>
          </figure>
          <div className="aelune-discovery-steps">
            {aelune.discovery.steps.map((step) => (
              <article className="aelune-discovery-step" key={step.number}>
                <span className="aelune-step-number">{step.number}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </div>
              </article>
            ))}
            <Link className="aelune-text-link" href={aelune.links.kiosk}>
              Explore the kiosk
              <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      <section
        className="aelune-retail aelune-section"
        id="for-stores"
        aria-labelledby="retail-title"
      >
        <div className="aelune-retail-copy">
          <span className="aelune-eyebrow">{aelune.retailer.eyebrow}</span>
          <h2 id="retail-title">
            {retailerLine}
            <br />
            <em>{retailerEmphasis}</em>
          </h2>
          <p>{aelune.retailer.description}</p>
          <div className="aelune-retail-features">
            {aelune.retailer.features.map((feature, index) => {
              const Icon = [Layers3, Store, Monitor][index];
              return (
                <div key={feature.title}>
                  <Icon size={21} aria-hidden="true" />
                  <div>
                    <h3>{feature.title}</h3>
                    <p>{feature.description}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <Link
            className="aelune-button aelune-button-light"
            href={aelune.links.signup}
          >
            Create your workspace
            <ArrowUpRight size={18} aria-hidden="true" />
          </Link>
        </div>
        <div className="aelune-workspace-visual">
          <div
            className="aelune-workspace-window"
            aria-label="Illustrative store workspace preview"
          >
            <div className="aelune-window-chrome">
              <span>
                <Circle size={5} fill="currentColor" />
                <Circle size={5} fill="currentColor" />
                <Circle size={5} fill="currentColor" />
              </span>
              <span>AELUNE / STORE WORKSPACE</span>
            </div>
            <div className="aelune-workspace-inner">
              <div className="aelune-workspace-title">
                <div>
                  <span>YOUR STORE, YOUR WAY</span>
                  <h3>A considered collection.</h3>
                </div>
                <span className="aelune-preview-plus">
                  <Plus size={19} aria-hidden="true" />
                </span>
              </div>
              <div className="aelune-workspace-tabs">
                <span>Product catalog</span>
                <span>Store availability</span>
                <span>Devices</span>
              </div>
              <div className="aelune-formula-sheet">
                <div className="aelune-formula-symbol" aria-hidden="true">
                  <Layers3 size={34} strokeWidth={1} />
                </div>
                <div>
                  <span>FORMULA REVIEW</span>
                  <h4>Every ingredient has a place.</h4>
                  <p>Complete formula · Recognized ingredients · Your review</p>
                </div>
              </div>
              <div className="aelune-preview-flow">
                <span>Draft</span>
                <ArrowRight size={15} aria-hidden="true" />
                <span>Review</span>
                <ArrowRight size={15} aria-hidden="true" />
                <span>
                  <Check size={13} aria-hidden="true" />
                  Publish
                </span>
              </div>
              <div className="aelune-preview-device">
                <ScanFace size={20} aria-hidden="true" />
                <div>
                  <strong>A welcome on every screen.</strong>
                  <span>Pair a tablet or browser-based mirror.</span>
                </div>
                <ArrowUpRight size={16} aria-hidden="true" />
              </div>
            </div>
          </div>
          <span className="aelune-workspace-caption">
            ILLUSTRATIVE WORKSPACE PREVIEW
          </span>
        </div>
      </section>

      <section
        className="aelune-privacy aelune-section"
        aria-labelledby="privacy-title"
      >
        <div className="aelune-privacy-statement">
          <ShieldCheck size={23} strokeWidth={1.3} aria-hidden="true" />
          <span className="aelune-eyebrow">PERSONAL. ON YOUR TERMS.</span>
          <h2 id="privacy-title">
            Your beauty.
            <br />
            <em>Your choice.</em>
          </h2>
          <p>
            No guest account. An optional photo. A clear choice before anything
            is sent.
          </p>
          <Link className="aelune-text-link" href={aelune.links.kiosk}>
            Find your starting point
            <ArrowUpRight size={18} aria-hidden="true" />
          </Link>
        </div>
        <div className="aelune-questions">
          <h3>A little more clarity.</h3>
          {aelune.questions.map((item) => (
            <details key={item.question}>
              <summary>
                {item.question}
                <Plus size={17} aria-hidden="true" />
              </summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="aelune-footer">
        <div className="aelune-footer-top">
          <Brand />
          <p>{aelune.tagline}</p>
          <a className="aelune-text-link" href="#top">
            Back to the surface
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </div>
        <div className="aelune-footer-wordmark" aria-hidden="true">
          AELUNE<span>·</span>
        </div>
        <div className="aelune-footer-bottom">
          <span>
            Working brand concept · Cosmetic discovery, not medical advice.
          </span>
          <div>
            <Link href={aelune.links.workspace}>Store workspace</Link>
            <Link href={aelune.links.styleTile}>Design studio</Link>
          </div>
          <span>Designed around you.</span>
        </div>
      </footer>
    </main>
  );
}
