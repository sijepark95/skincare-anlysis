"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Boxes,
  Check,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Eye,
  LayoutDashboard,
  Leaf,
  LogOut,
  Monitor,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";
import type {
  CatalogWrite,
  DeviceRecord,
  Metrics,
  StaffContext,
} from "@/application/contracts";
import type { Product } from "@/domain";
import { OPENAI_SKIN_MODEL } from "@/domain/skin-vision";
import { ApiError, api, json } from "./api";
import { Brand } from "./brand";
import { ProductArt } from "./product-art";
import { ProductEditor } from "./management/product-editor";
import { ListingEditor } from "./management/listing-editor";
import { ImportDialog } from "./management/import-dialog";
import { PairingDialog } from "./management/pairing-dialog";
import { CosmeticShadeEditor } from "./management/cosmetic-shade-editor";
import { isCosmeticCategory } from "@/domain/cosmetic-shades";
import { BeautyDemographicsPanel } from "./management/beauty-demographics";

type Overview = {
  products: Product[];
  metrics: Metrics;
  devices: DeviceRecord[];
};
const emptyOverview: Overview = {
  products: [],
  metrics: { started: 0, completed: 0, analyzed: 0 },
  devices: [],
};
const money = (product: Product) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: product.currency,
  }).format(product.priceMinor / 100);
const blank: CatalogWrite = {
  sku: "",
  brand: "",
  name: "",
  category: "serum",
  priceMinor: 0,
  currency: "USD",
  stock: 0,
  visible: false,
  ingredients: [],
  formulaComplete: false,
  suitableSkinTypes: [],
};
export function Management({ section }: { section: string }) {
  const router = useRouter();
  const [staff, setStaff] = useState<StaffContext | null>(null);
  const [mode, setMode] = useState("");
  const [analysisMode, setAnalysisMode] = useState<
    "mock" | "experimental" | "openai"
  >("mock");
  const experimental = analysisMode === "experimental";
  const openai = analysisMode === "openai";
  const [explanationAvailable, setExplanationAvailable] = useState(false);
  const [store, setStore] = useState("");
  const [data, setData] = useState<Overview>(emptyOverview);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<CatalogWrite | null>(null);
  const [listing, setListing] = useState<Product | null>(null);
  const [shadeProduct, setShadeProduct] = useState<Product | null>(null);
  const [importing, setImporting] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [busy, setBusy] = useState(false);
  const storeIdentity = useRef("");
  const loadSequence = useRef(0);
  useEffect(() => {
    api<{
      staff: StaffContext | null;
      mode: string;
      analysisMode: "mock" | "experimental" | "openai";
      explanationAvailable: boolean;
    }>("context")
      .then(async (value) => {
        setMode(value.mode);
        setAnalysisMode(value.analysisMode);
        setExplanationAvailable(
          value.analysisMode !== "openai" && value.explanationAvailable,
        );
        if (!value.staff) {
          const account = await api<{
            authenticated: boolean;
            needsWorkspace: boolean;
          }>("auth/account");
          router.replace(
            account.authenticated && account.needsWorkspace
              ? "/management/setup"
              : "/management/login",
          );
          return;
        }
        setStaff(value.staff);
        const saved = sessionStorage.getItem(
          `senmiva-store:${value.staff.organizationId}`,
        );
        const selected = value.staff.stores.some((s) => s.id === saved)
          ? saved!
          : (value.staff.stores[0]?.id ?? "");
        storeIdentity.current = selected;
        setStore(selected);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [router]);
  const load = useCallback(() => {
    if (!store) return Promise.resolve();
    const sequence = ++loadSequence.current;
    return api<Overview>(`management/overview?storeId=${store}`)
      .then((value) => {
        if (
          storeIdentity.current === store &&
          loadSequence.current === sequence
        ) {
          setData(value);
          setError("");
        }
      })
      .catch((e) => {
        if (storeIdentity.current !== store) return;
        if (e instanceof ApiError && e.status === 401) {
          storeIdentity.current = "";
          setStaff(null);
          setData(emptyOverview);
          router.replace("/management/login");
          return;
        }
        setError((e as Error).message);
      })
      .finally(() => {
        if (storeIdentity.current === store) setLoading(false);
      });
  }, [store, router]);
  useEffect(() => {
    void load();
  }, [load]);
  const closeProduct = useCallback(() => setEditing(null), []);
  const closeImport = useCallback(() => setImporting(false), []);
  const closeListing = useCallback(() => setListing(null), []);
  const closeShade = useCallback(() => setShadeProduct(null), []);
  const closePair = useCallback(() => {
    setPairing(false);
  }, []);
  async function mutate(path: string, body?: unknown, method = "POST") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const value = await api(path + `?storeId=${store}`, {
        method,
        body: body === undefined ? undefined : json(body),
      });
      await load();
      return value;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        storeIdentity.current = "";
        setStaff(null);
        setData(emptyOverview);
        router.replace("/management/login");
      }
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const owner = staff?.role === "owner",
    canManage = owner || staff?.role === "manager";
  const viewer = staff?.role === "viewer";
  const nav = [
    { id: "overview", name: "Overview", icon: LayoutDashboard },
    { id: "catalog", name: "Product catalog", icon: Boxes },
    { id: "devices", name: "Devices", icon: Monitor },
    { id: "settings", name: "Workspace settings", icon: Settings },
  ].filter((item) => !viewer || !["catalog", "devices"].includes(item.id));
  const validSection = nav.some((item) => item.id === section);
  const current = validSection ? section : "overview";
  const products = data.products.filter((p) =>
    `${p.name} ${p.brand} ${p.sku}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Brand />
        <span className="workspace-label">STORE WORKSPACE</span>
        <nav className="side-nav" aria-label="Workspace navigation">
          {nav.map((item) => (
            <Link
              className={current === item.id ? "active" : ""}
              aria-current={current === item.id ? "page" : undefined}
              href={
                item.id === "overview"
                  ? "/management"
                  : `/management/${item.id}`
              }
              key={item.id}
            >
              <item.icon size={18} />
              {item.name}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="pill lavender">
            <Sparkles size={11} />
            {openai
              ? "OpenAI photo analysis"
              : experimental
                ? "Experimental analysis"
                : "Mock analysis"}
          </span>
          <p>
            A thoughtful start to your store's
            <br />
            personal beauty experience.
          </p>
          <Link className="text-button" href="/kiosk">
            <Monitor size={16} />
            Open kiosk <ArrowUpRight size={14} />
          </Link>
        </div>
      </aside>
      <div className="workspace-content">
        <header className="workspace-topbar">
          <label>
            <span>CURRENT STORE</span>
            <select
              aria-label="Current store"
              value={store}
              onChange={(e) => {
                storeIdentity.current = e.target.value;
                if (staff)
                  sessionStorage.setItem(
                    `senmiva-store:${staff.organizationId}`,
                    e.target.value,
                  );
                setStore(e.target.value);
                setData(emptyOverview);
                setLoading(true);
                setPairing(false);
                setShadeProduct(null);
                setMessage("");
                setError("");
              }}
            >
              {staff?.stores.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="workspace-user">
            {mode === "demo" && <span className="pill">Local demo</span>}
            <span className="subtle">
              {staff?.organizationName ?? "Workspace"} · {staff?.role}
            </span>
            <span className="avatar" aria-hidden="true">
              SM
            </span>
            {mode === "supabase" && (
              <button
                className="text-button"
                aria-label="Sign out"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await api("auth/logout", { method: "POST", body: "{}" });
                    storeIdentity.current = "";
                    setStaff(null);
                    setData(emptyOverview);
                    router.replace("/management/login");
                  } catch (cause) {
                    setError((cause as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <LogOut size={16} />
              </button>
            )}
          </div>
        </header>
        <main className="workspace-main">
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          {current === "overview" && (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">A LITTLE CLARITY FOR YOUR DAY</span>
                  <h1>Your store, at a glance.</h1>
                  <p>A simple view of your beauty discovery experience.</p>
                </div>
                <Link className="button secondary" href="/kiosk">
                  Preview kiosk <ArrowUpRight size={16} />
                </Link>
              </div>
              {mode === "demo" && (
                <div className="banner">
                  <div>
                    <h2>Your next beauty moment starts here.</h2>
                    <p>
                      Explore skin, personal color and styling in one beauty
                      book. Photo observations are
                      {openai
                        ? "unvalidated cosmetic photo observations from OpenAI, with separately consented photo transmission and store-policy product matching."
                        : experimental
                          ? "experimental, with trained ingredient candidates and store product matching."
                          : "simulated, with real ingredient-to-product matching."}
                    </p>
                  </div>
                  <Link className="button primary" href="/kiosk">
                    Try the experience <ArrowUpRight size={16} />
                  </Link>
                </div>
              )}
              <div className="stats-grid">
                <article className="stat-card">
                  <span>
                    Sessions started <ScanIcon />
                  </span>
                  <strong>{data.metrics.started}</strong>
                  <p>
                    {mode === "demo"
                      ? "Since this demo process started"
                      : "Today · UTC"}
                  </p>
                </article>
                <article className="stat-card">
                  <span>
                    Sessions completed <Check size={16} />
                  </span>
                  <strong>{data.metrics.completed}</strong>
                  <p>Guests who finished their result session</p>
                </article>
                <article className="stat-card">
                  <span>
                    {viewer ? "Mock analyses" : "Ready for discovery"}{" "}
                    <Leaf size={16} />
                  </span>
                  <strong>
                    {viewer
                      ? data.metrics.analyzed
                      : data.products.filter(
                          (p) =>
                            p.status === "published" &&
                            p.visible &&
                            p.stock > 0,
                        ).length}
                  </strong>
                  <p>
                    {viewer
                      ? "Today · UTC"
                      : "Published, visible products in stock"}
                  </p>
                </article>
              </div>
              <div className="workspace-panels">
                {mode !== "demo" && (
                  <BeautyDemographicsPanel key={store} storeId={store} />
                )}
                {!viewer && (
                  <section className="panel">
                    <div className="panel-head">
                      <h2>Your product shelf</h2>
                      <Link className="text-button" href="/management/catalog">
                        View catalog <ChevronRight size={14} />
                      </Link>
                    </div>
                    {data.products.slice(0, 4).map((p) => (
                      <div className="mini-product" key={p.id}>
                        <ProductArt category={p.category} name={p.name} />
                        <div>
                          <h3>{p.name}</h3>
                          <p>
                            {p.brand} · {money(p)}
                          </p>
                        </div>
                        <span
                          className={`pill ${p.status === "published" ? "published" : ""}`}
                        >
                          {p.status}
                        </span>
                      </div>
                    ))}
                    {!loading && !data.products.length && (
                      <p className="empty">Add your first product to begin.</p>
                    )}
                  </section>
                )}
                <section className="panel">
                  <h2>A strong start, step by step</h2>
                  {[
                    {
                      title: "Build your product shelf",
                      text: "Register full ingredient lists, review drafts, then publish.",
                    },
                    {
                      title: "Pair your in-store tablet",
                      text: "Create a one-time code and connect the kiosk to this store.",
                    },
                    {
                      title: "Make every match meaningful",
                      text: "Recommendations use approved ingredients, availability and guest preferences.",
                    },
                  ].map((item, i) => (
                    <div className="setup-step" key={item.title}>
                      <span>{i + 1}</span>
                      <div>
                        <h3>{item.title}</h3>
                        <p>{item.text}</p>
                      </div>
                    </div>
                  ))}
                  <p className="fine-print">
                    <ShieldCheck size={14} /> Customer photos, answers and
                    results never appear in this workspace.
                  </p>
                </section>
              </div>
            </>
          )}
          {current === "catalog" && (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">YOUR SHELF, PERSONALIZED</span>
                  <h1>Product catalog.</h1>
                  <p>
                    Organization products, with pricing and availability for
                    this store.
                  </p>
                </div>
                {owner && (
                  <div className="title-actions">
                    <button
                      className="button secondary"
                      onClick={() => setImporting(true)}
                    >
                      <Upload size={16} />
                      Import CSV
                    </button>
                    <button
                      className="button primary"
                      onClick={() => setEditing({ ...blank })}
                    >
                      <Plus size={16} />
                      Add product
                    </button>
                  </div>
                )}
              </div>
              <div className="catalog-toolbar">
                <label className="search-field">
                  <Search size={16} />
                  <span className="sr-only">Search products</span>
                  <input
                    placeholder="Search name, brand or SKU"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <span>{products.length} products · USD</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Status</th>
                      <th>Store price</th>
                      <th>Stock</th>
                      <th>Visibility</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <div className="table-product">
                            <ProductArt category={p.category} name={p.name} />
                            <div>
                              <strong>{p.name}</strong>
                              <small>
                                {p.brand} · {p.sku}
                              </small>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span
                            className={`pill ${p.status === "published" ? "published" : ""}`}
                          >
                            {p.status}
                          </span>
                        </td>
                        <td>{money(p)}</td>
                        <td>{p.stock}</td>
                        <td>{p.visible ? "Visible" : "Hidden"}</td>
                        <td>
                          {owner && (
                            <button
                              className="table-action"
                              onClick={() => setEditing({ ...p })}
                            >
                              Edit details
                            </button>
                          )}
                          {canManage && (
                            <button
                              className="table-action"
                              onClick={() => setListing(p)}
                            >
                              <Eye size={13} />
                              Store listing
                            </button>
                          )}
                          {owner && isCosmeticCategory(p.category) && (
                            <button
                              className="table-action"
                              onClick={() => setShadeProduct(p)}
                            >
                              Review cosmetic shade
                            </button>
                          )}
                          {owner && p.status === "draft" && (
                            <button
                              className="table-action"
                              disabled={busy}
                              onClick={() =>
                                void mutate(
                                  `management/products/${p.id}/publish`,
                                  {},
                                )
                                  .then(() =>
                                    setMessage(
                                      "Product published. Check this store's visibility and stock before recommending it.",
                                    ),
                                  )
                                  .catch(() => {})
                              }
                            >
                              Publish
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {loading && (
                  <p className="empty" role="status">
                    Loading your shelf…
                  </p>
                )}
                {!loading && !products.length && (
                  <p className="empty">No products match this view.</p>
                )}
              </div>
              <p className="fine-print" style={{ marginTop: 18 }}>
                Only published products with complete, recognized ingredients,
                positive stock and store visibility can be recommended. Editing
                details returns the shared formulation to draft for review.
              </p>
            </>
          )}
          {current === "devices" && (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">CONNECTED TO YOUR STORE</span>
                  <h1>Your in-store devices.</h1>
                  <p>
                    Pair a tablet or browser-based mirror. Revoke access when a
                    device leaves your store.
                  </p>
                </div>
                {canManage && (
                  <button
                    className="button primary"
                    onClick={() => setPairing(true)}
                  >
                    <Plus size={16} />
                    Pair new device
                  </button>
                )}
              </div>
              <div className="device-grid">
                {data.devices.map((device) => (
                  <article className="device-card" key={device.id}>
                    <Monitor size={27} color="#8b739d" />
                    <h3>{device.label}</h3>
                    <span
                      className={`pill ${device.revoked ? "" : "published"}`}
                    >
                      {device.revoked ? "Revoked" : "Paired"}
                    </span>
                    <p>
                      {device.lastSeen
                        ? `Last activity ${new Date(device.lastSeen).toLocaleString()}`
                        : "No activity yet"}
                    </p>
                    {!device.revoked && canManage && (
                      <button
                        className="button secondary wide"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            `management/devices/${device.id}`,
                            {},
                            "DELETE",
                          )
                            .then(() =>
                              setMessage(
                                "Device access revoked and its active session cleared.",
                              ),
                            )
                            .catch(() => {})
                        }
                      >
                        Revoke device access
                      </button>
                    )}
                  </article>
                ))}
              </div>
              {!loading && !data.devices.length && (
                <section className="panel empty">
                  <Monitor size={30} />
                  <h3>No paired devices yet.</h3>
                  <p>
                    Create a pairing code, then open the kiosk on your tablet.
                  </p>
                </section>
              )}
            </>
          )}
          {current === "settings" && (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">A THOUGHTFUL FOUNDATION</span>
                  <h1>Workspace settings.</h1>
                  <p>
                    Your current operating configuration and privacy defaults.
                  </p>
                </div>
              </div>
              <div className="settings-grid">
                <section className="panel">
                  <h2>Workspace & access</h2>
                  {[
                    ["Organization", staff?.organizationName ?? ""],
                    ["Your role", staff?.role ?? ""],
                    [
                      "Environment",
                      mode === "demo" ? "Local demo" : "Supabase",
                    ],
                    ["Currency", "USD (MVP)"],
                    [
                      "Skin analysis",
                      openai
                        ? "OpenAI · visible photo features"
                        : experimental
                          ? "Experimental · local models"
                          : "Simulated · mock provider",
                    ],
                    [
                      "Ingredient ranking",
                      openai
                        ? "Visible appearance goals + store policy"
                        : experimental
                          ? "Trained candidate model + store policy"
                          : "Store ingredient policy",
                    ],
                    [
                      "Recommendation notes",
                      explanationAvailable
                        ? "OpenAI · optional guest consent"
                        : "Reviewed ingredient reasons",
                    ],
                  ].map(([key, value]) => (
                    <div className="setting-row" key={key}>
                      <span>{key}</span>
                      <strong>{value}</strong>
                    </div>
                  ))}
                  <p className="fine-print" style={{ marginTop: 20 }}>
                    Account membership and approved recommendation policies are
                    provisioned by the organization owner through the secure
                    setup procedure.
                  </p>
                </section>
                <section className="panel">
                  <h2>Privacy defaults</h2>
                  {[
                    ["Customer accounts", "Not required"],
                    [
                      "Photo storage",
                      openai
                        ? "Memory only in this application"
                        : experimental
                          ? "Memory only · never saved"
                          : "Browser memory only",
                    ],
                    [
                      "Photo uploads",
                      openai
                        ? "OpenAI · separate optional adult consent"
                        : experimental
                          ? "Private service · with consent"
                          : "Disabled in mock mode",
                    ],
                    ...(openai
                      ? [
                          [
                            "External photo retention",
                            "OpenAI abuse logs · up to 30 days",
                          ],
                        ]
                      : []),
                    ["Kiosk idle reset", "2 minutes"],
                    ["Abandoned session expiry", "15 minutes"],
                    ["Staff session access", "Aggregate counts only"],
                    [
                      "External explanation sharing",
                      explanationAvailable
                        ? "Matching goals and ingredients only"
                        : "Disabled",
                    ],
                  ].map(([key, value]) => (
                    <div className="setting-row" key={key}>
                      <span>{key}</span>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </section>
                <section className="panel">
                  <h2>Beauty book &amp; saved guides</h2>
                  <p>
                    Guests confirm a palette, face-shape direction and style
                    preferences before exploring makeup, hair and jewelry ideas.
                    Lip shades match reviewed shade metadata, complete published
                    formulas, current store stock and ingredient exclusions.
                    Register lip products and use Review lip shade in the
                    catalog.
                  </p>
                  <p className="fine-print">
                    Photo suggestions require fresh, separate permission and are
                    approximate. Optional QR guides require a public HTTPS
                    address and separate seven-day saving consent. They contain
                    confirmed choices and product references, without photos or
                    AI observations, and can be deleted by the link holder.
                    Staff see aggregate activity only.
                  </p>
                </section>
                <section className="panel">
                  <h2>Skincare recommendation principles</h2>
                  <p>
                    Approved concern-to-ingredient rules are matched to complete
                    product formulations. Availability, visibility and
                    exclusions filter the results. Every match includes
                    ingredient reasons.
                  </p>
                  <p className="fine-print">
                    Adding a product does not require retraining a model. This{" "}
                    {openai
                      ? "version uses questionnaire goals and usable-photo appearance goals within the store's reviewed ingredient policy. Only clearly visible spots, pores or fine lines can contribute; redness and flaking remain observations. Skin type, exclusions, stock and visibility still apply."
                      : experimental
                        ? "version uses learned ingredient candidates within the store's policy. Supported photo-code combinations seen in recommendation training can contribute to ranking. Selected goals, store policy, stock and exclusions still govern product matches."
                        : "version uses a deterministic store policy for ranking."}{" "}
                    {openai
                      ? "Photo observations appear before products, including when no eligible product is available."
                      : explanationAvailable
                        ? "With separate guest permission, OpenAI helps present existing match facts after products are selected. It cannot change the product selection. If it is unavailable, reviewed ingredient reasons remain visible."
                        : "Optional hosted explanations can be enabled through private server configuration. Ingredient reasons remain available without them."}
                  </p>
                  <p className="fine-print">
                    {openai
                      ? "OpenAI receives a bounded, metadata-stripped face photo only with separate guest consent. The application never saves photos. OpenAI may retain abuse-monitoring logs for up to 30 days even with response storage disabled. Declining photo analysis keeps the camera off and uses questionnaire-based matches."
                      : "Hosted explanations never receive photos, identity, raw analysis or training records. OpenAI may retain abuse-monitoring logs for up to 30 days. Clearing a kiosk session removes this installation's temporary results; provider retention follows its own terms."}
                  </p>
                </section>
                <section className="panel">
                  <h2>Designed to grow</h2>
                  <p>
                    {openai
                      ? `The private analysis service uses ${OPENAI_SKIN_MODEL} for redness, visible spots, pores, fine lines and flaking. It does not run ConvNeXt or a learned ingredient model in this mode. Image limitations remain visible; these observations are unvalidated and do not establish a diagnosis, hydration level or sensitivity.`
                      : experimental
                        ? "The private service runs the saved ConvNeXt-Tiny skin experiment and structured ingredient model. Source code meanings and the combined pipeline's accuracy remain unverified. These models remain unvalidated for retail use. Adding products does not change or retrain them."
                        : "The analysis service has a separate provider boundary for a future validated ConvNeXt model. Training requires confirmed data access and usage permission."}
                  </p>
                  <p className="fine-print">
                    This workspace intentionally offers no diagnostic claims,
                    customer portraits or individual skin histories.
                  </p>
                </section>
              </div>
            </>
          )}
          <p
            className="fine-print"
            style={{
              marginTop: 30,
              display: "flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            <CircleHelp size={13} />
            {mode === "demo"
              ? "Demo catalog saves locally. Demo sessions and counters reset when the server restarts."
              : "Operational counts only. Individual customer sessions are private and temporary."}
          </p>
        </main>
      </div>
      {editing && (
        <ProductEditor
          initial={editing}
          close={closeProduct}
          save={async (value) => {
            await mutate("management/products", value);
            setEditing(null);
            setMessage(
              "Product saved as a draft. Review its ingredients before publishing.",
            );
          }}
        />
      )}
      {listing && (
        <ListingEditor
          product={listing}
          close={closeListing}
          save={async (value) => {
            await mutate(
              `management/products/${listing.id}/listing`,
              value,
              "PATCH",
            );
            setListing(null);
            setMessage("Store listing updated.");
          }}
        />
      )}
      {shadeProduct && owner && (
        <CosmeticShadeEditor
          key={`${store}:${shadeProduct.id}`}
          product={shadeProduct}
          storeId={store}
          close={closeShade}
          saved={() => {
            setShadeProduct(null);
            setMessage(
              "Reviewed cosmetic shade published. Formula, stock and store visibility still determine eligibility.",
            );
          }}
        />
      )}
      {importing && (
        <ImportDialog
          store={store}
          close={closeImport}
          saved={async (count) => {
            setImporting(false);
            await load();
            setMessage(
              `${count} products imported as drafts. Review and publish each product before it can be recommended.`,
            );
          }}
        />
      )}
      {pairing && (
        <PairingDialog
          storeId={store}
          storeName={
            staff?.stores.find((entry) => entry.id === store)?.name ??
            "your store"
          }
          close={closePair}
        />
      )}
    </div>
  );
}
function ScanIcon() {
  return <ClipboardList size={16} />;
}
