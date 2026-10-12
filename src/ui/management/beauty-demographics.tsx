"use client";
import { useEffect, useState } from "react";
import type { BeautyDemographics } from "@/application/beauty-complete-contracts";
import { api } from "../api";
export function BeautyDemographicsPanel({ storeId }: { storeId: string }) {
  const [data, setData] = useState<BeautyDemographics | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<BeautyDemographics>(
      `management/beauty-demographics?storeId=${encodeURIComponent(storeId)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setError("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Demographic reporting is unavailable.");
      });
    return () => controller.abort();
  }, [storeId]);
  return (
    <section className="panel">
      <h2>Opt-in adult sessions</h2>
      <p className="fine-print">
        Completed sessions, not unique visitors. The last four closed UTC weeks;
        teens and non-consenting guests are excluded.
      </p>
      {error ? (
        <p role="status">{error}</p>
      ) : !data ? (
        <p role="status">Loading report…</p>
      ) : (
        <>
          <p className="fine-print">
            {data.periodStart} – {data.periodEnd} (end exclusive)
          </p>
          {(["age", "gender"] as const).map((d) => (
            <div key={d}>
              <h3>{d === "age" ? "Age bands" : "Gender"}</h3>
              {data[d].suppressed ? (
                <p>Hidden to protect small groups.</p>
              ) : Object.keys(data[d].counts).length ? (
                <dl>
                  {Object.entries(data[d].counts).map(([bucket, count]) => (
                    <div
                      key={bucket}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 16,
                      }}
                    >
                      <dt>{bucket.replaceAll("_", " ")}</dt>
                      <dd>{count}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>No eligible completed sessions in this period.</p>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
