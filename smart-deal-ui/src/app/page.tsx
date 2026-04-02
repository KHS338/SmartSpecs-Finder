"use client";

import { useState } from "react";

interface PhoneSource {
  id: string;
  name: string;
  price: number;
  url: string;
}

interface PhoneDetails {
  id: string;
  name: string;
  company: string;
  model: string;
  pricePkr: number | null;
  url: string;
  colors: string;
  storageOptions: string;
  maxStorageGb: number | null;
  batteryMah: number | null;
  screenSizeInches: number | null;
  displayType: string;
  refreshRateHz: number | null;
  ramGb: number | null;
  processor: string;
  operatingSystem: string;
  releaseDate: string;
  simSupport: string;
  has5G: boolean | null;
  hasNfc: boolean | null;
  hasWifi: boolean | null;
  hasBluetooth: boolean | null;
  backCameraMp: number | null;
  frontCameraMp: number | null;
  rawSpecs: Record<string, unknown> | null;
}

interface Message {
  role: "user" | "ai";
  text: string;
}

interface RefreshLiveResult {
  message: string;
  count: number;
  scrapeFilePath: string;
  analyticsFilePath: string;
  indexStatus: string;
}

export default function Dashboard() {
  const [query, setQuery] = useState("");
  const [chat, setChat] = useState<Message[]>([]);
  const [recommendedPhones, setRecommendedPhones] = useState<PhoneSource[]>([]);
  const [selectedPhoneId, setSelectedPhoneId] = useState<string | null>(null);
  const [selectedPhoneDetails, setSelectedPhoneDetails] =
    useState<PhoneDetails | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<RefreshLiveResult | null>(
    null,
  );

  const refreshLiveData = async () => {
    setIsRefreshing(true);
    setRefreshResult(null);

    try {
      const response = await fetch("http://localhost:3000/rag/refresh-live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const data = (await response.json()) as RefreshLiveResult;
      setRefreshResult(data);
      setChat((prev) => [
        ...prev,
        {
          role: "ai",
          text: `Live refresh done. Scraped ${data.count} phones, generated analytics report, and refreshed the vector index.`,
        },
      ]);
    } catch {
      setChat((prev) => [
        ...prev,
        {
          role: "ai",
          text: "Live refresh failed. Make sure backend and scraper dependencies are running.",
        },
      ]);
    } finally {
      setIsRefreshing(false);
    }
  };

  const askOracle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    const userMessage = query;
    setChat((prev) => [...prev, { role: "user", text: userMessage }]);
    setQuery("");
    setIsLoading(true);

    try {
      const response = await fetch("http://localhost:3000/rag/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: userMessage }),
      });

      const data = await response.json();

      setChat((prev) => [...prev, { role: "ai", text: data.recommendation }]);
      const recommendationText =
        typeof data.recommendation === "string" ? data.recommendation : "";

      // Update the UI with metadata extracted from ChromaDB
      if (Array.isArray(data.sources) && data.sources.length > 0) {
        // Remove duplicates just in case the vector DB pulled overlapping chunks
        const uniquePhones = dedupePhones(data.sources as PhoneSource[]);
        setRecommendedPhones(
          filterPhonesByRecommendation(
            uniquePhones as PhoneSource[],
            recommendationText,
          ),
        );
        setSelectedPhoneId(null);
        setSelectedPhoneDetails(null);
        setDetailsError(null);
      } else if (data.rawResult) {
        const parsedResult = parseSqlRows(data.rawResult);

        const sqlPhones: PhoneSource[] = parsedResult
          .map((row) => {
            const id = typeof row.id === "string" ? row.id : "";
            const name = typeof row.name === "string" ? row.name : "Unknown";
            const url = typeof row.url === "string" ? row.url : "";
            const price =
              typeof row.price_pkr === "number"
                ? row.price_pkr
                : typeof row.price_pkr === "string"
                  ? Number.parseInt(row.price_pkr, 10)
                  : 0;

            if (!name) {
              return null;
            }

            return {
              id: id || name,
              name,
              url,
              price: Number.isFinite(price) ? price : 0,
            } satisfies PhoneSource;
          })
          .filter((item): item is PhoneSource => item !== null);

        const uniquePhones = dedupePhones(sqlPhones);

        setRecommendedPhones(
          filterPhonesByRecommendation(uniquePhones, recommendationText),
        );
        setSelectedPhoneId(null);
        setSelectedPhoneDetails(null);
        setDetailsError(null);
      } else {
        setRecommendedPhones([]);
        setSelectedPhoneId(null);
        setSelectedPhoneDetails(null);
        setDetailsError(null);
      }
    } catch {
      setChat((prev) => [
        ...prev,
        { role: "ai", text: "Error connecting to the backend API. Is NestJS running?" },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const getConnectivityLabel = (value: boolean | null) => {
    if (value === true) return "Yes";
    if (value === false) return "No";
    return "N/A";
  };

  const formatNumber = (value: number | null, suffix = "") => {
    if (value === null) return "N/A";
    return `${value}${suffix}`;
  };

  const parseSqlRows = (rawResult: unknown): Array<Record<string, unknown>> => {
    if (Array.isArray(rawResult)) {
      return rawResult.filter(
        (item): item is Record<string, unknown> => !!item && typeof item === "object",
      );
    }

    if (typeof rawResult === "string") {
      try {
        const parsed = JSON.parse(rawResult) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.filter(
            (item): item is Record<string, unknown> => !!item && typeof item === "object",
          );
        }
      } catch {
        return [];
      }
    }

    return [];
  };

  const filterPhonesByRecommendation = (
    phones: PhoneSource[],
    recommendation: string,
  ): PhoneSource[] => {
    const normalizedRecommendation = recommendation.toLowerCase();
    const mentioned = phones.filter((phone) =>
      normalizedRecommendation.includes(phone.name.toLowerCase()),
    );

    return mentioned.length > 0 ? mentioned : phones;
  };

  const dedupePhones = (phones: PhoneSource[]): PhoneSource[] => {
    return Array.from(
      new Map(phones.map((item) => [item.url || item.name, item])).values(),
    );
  };

  const openPhoneDetails = async (phone: PhoneSource) => {
    setSelectedPhoneId(phone.id);
    setIsLoadingDetails(true);
    setDetailsError(null);

    try {
      const response = await fetch("http://localhost:3000/rag/sql/phone-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: phone.id, url: phone.url, name: phone.name }),
      });

      const data = (await response.json()) as {
        found?: boolean;
        details?: PhoneDetails | null;
      };

      if (!response.ok) {
        setSelectedPhoneDetails(null);
        setDetailsError("Unable to load details for this phone.");
        return;
      }

      if (!data.found || !data.details) {
        setSelectedPhoneDetails(null);
        setDetailsError("No analytics details found for this phone.");
        return;
      }

      setSelectedPhoneDetails(data.details);
    } catch {
      setSelectedPhoneDetails(null);
      setDetailsError("Unable to connect to backend for phone details.");
    } finally {
      setIsLoadingDetails(false);
    }
  };

  return (
    <main className="flex flex-col md:flex-row h-screen bg-neutral-950 text-neutral-200 font-sans overflow-hidden">
      
      {/* LEFT PANEL: Chat Interface */}
      <section className="w-full md:w-[400px] lg:w-[500px] flex flex-col border-r border-neutral-800 bg-neutral-900 shadow-2xl z-10">
        <header className="p-6 border-b border-neutral-800 bg-neutral-900">
          <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
            <span className="bg-emerald-500 w-3 h-3 rounded-full animate-pulse"></span>
            SmartSpecs AI
          </h1>
          <p className="text-sm text-neutral-400 mt-1">Intelligent Smartphone Recommender</p>
          <button
            type="button"
            onClick={refreshLiveData}
            disabled={isRefreshing || isLoading}
            className="mt-4 w-full rounded-lg border border-emerald-700 bg-emerald-900/30 px-4 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-800/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRefreshing
              ? "Running Live Scraper + Analytics..."
              : "Run Live Scraper + Auto Analytics"}
          </button>
          {refreshResult && (
            <div className="mt-3 rounded-lg border border-neutral-700 bg-neutral-950/70 p-3 text-xs text-neutral-300">
              <p className="font-semibold text-emerald-300">{refreshResult.message}</p>
              <p>Phones scraped: {refreshResult.count}</p>
              <p className="truncate">Scrape file: {refreshResult.scrapeFilePath}</p>
              <p className="truncate">Analytics file: {refreshResult.analyticsFilePath}</p>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-neutral-700">
          {chat.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-neutral-500 space-y-4">
              <svg className="w-12 h-12 text-neutral-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>
              </svg>
              <p>Tell me your budget and requirements.<br/>e.g., &quot;I need a gaming phone under 300k&quot;</p>
            </div>
          ) : (
            chat.map((msg, idx) => (
              <div key={idx} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                <div className={`max-w-[85%] p-4 rounded-2xl ${msg.role === "user" ? "bg-emerald-600 text-white rounded-br-none" : "bg-neutral-800 text-neutral-200 border border-neutral-700 rounded-bl-none"}`}>
                  <p className="whitespace-pre-wrap leading-relaxed text-sm md:text-base">{msg.text}</p>
                </div>
              </div>
            ))
          )}
          {isLoading && (
            <div className="flex items-center gap-2 text-neutral-500 text-sm p-4">
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce"></div>
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: "0.2s" }}></div>
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: "0.4s" }}></div>
            </div>
          )}
        </div>

        <div className="p-4 bg-neutral-900 border-t border-neutral-800">
          <form onSubmit={askOracle} className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What are you looking for?"
              className="flex-1 bg-neutral-950 border border-neutral-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all text-sm"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading}
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold px-4 py-3 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
            </button>
          </form>
        </div>
      </section>

      {/* RIGHT PANEL: Live Data Dashboard */}
      <section className="flex-1 bg-neutral-950 p-6 md:p-10 overflow-y-auto">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-xl font-semibold text-neutral-300 mb-6 flex items-center gap-2">
            <svg className="w-5 h-5 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"></path></svg>
            Database Matches
          </h2>
          
          <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
            <div className="xl:col-span-3">
              {recommendedPhones.length === 0 ? (
                <div className="border border-dashed border-neutral-800 rounded-2xl h-64 flex items-center justify-center text-neutral-600 bg-neutral-900/50">
                  Matches will appear here during the conversation.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {recommendedPhones.map((phone, idx) => {
                    const isActive = selectedPhoneId === phone.id;
                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => void openPhoneDetails(phone)}
                        className={`text-left bg-neutral-900 border rounded-xl overflow-hidden transition-colors group flex flex-col ${
                          isActive
                            ? "border-emerald-500"
                            : "border-neutral-800 hover:border-emerald-500/50"
                        }`}
                      >
                        <div className="p-5 flex-1">
                          <h3 className="text-lg font-bold text-white mb-2 line-clamp-2">{phone.name}</h3>
                          <div className="inline-block bg-neutral-950 border border-neutral-700 rounded text-emerald-400 font-mono text-sm px-2 py-1 mb-3">
                            {phone.price > 0 ? `Rs ${phone.price.toLocaleString()}` : "Price N/A"}
                          </div>
                          <p className="text-xs text-neutral-500">Click card to view full analytics info</p>
                        </div>
                        <div className="bg-neutral-950 p-4 border-t border-neutral-800 mt-auto">
                          {phone.url ? (
                            <a
                              href={phone.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(event) => event.stopPropagation()}
                              className="text-sm font-medium text-neutral-400 hover:text-emerald-400 flex items-center justify-between transition-colors w-full"
                            >
                              View on PriceOye
                              <svg className="w-4 h-4 transform group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                            </a>
                          ) : (
                            <p className="text-sm text-neutral-500">Store link unavailable for this result</p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <aside className="xl:col-span-2 bg-neutral-900 border border-neutral-800 rounded-2xl p-5">
              <h3 className="text-base font-semibold text-neutral-200 mb-4">Selected Match Details</h3>

              {recommendedPhones.length === 0 && (
                <p className="text-sm text-neutral-500">Ask a query first to get matches.</p>
              )}

              {recommendedPhones.length > 0 && !selectedPhoneDetails && !isLoadingDetails && !detailsError && (
                <p className="text-sm text-neutral-500">Click any match card to load detailed analytics info.</p>
              )}

              {isLoadingDetails && (
                <p className="text-sm text-neutral-400">Loading phone details...</p>
              )}

              {detailsError && (
                <p className="text-sm text-red-400">{detailsError}</p>
              )}

              {selectedPhoneDetails && (
                <div className="space-y-3 text-sm">
                  <p className="text-white font-semibold text-lg">{selectedPhoneDetails.name}</p>
                  <p className="text-emerald-400 font-mono">
                    Rs {(selectedPhoneDetails.pricePkr ?? 0).toLocaleString()}
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-neutral-300">
                    <p>Brand: {selectedPhoneDetails.company}</p>
                    <p>Model: {selectedPhoneDetails.model}</p>
                    <p>Display: {selectedPhoneDetails.displayType}</p>
                    <p>Refresh: {formatNumber(selectedPhoneDetails.refreshRateHz, " Hz")}</p>
                    <p>Screen: {formatNumber(selectedPhoneDetails.screenSizeInches, " in")}</p>
                    <p>Battery: {formatNumber(selectedPhoneDetails.batteryMah, " mAh")}</p>
                    <p>RAM: {formatNumber(selectedPhoneDetails.ramGb, " GB")}</p>
                    <p>Max Storage: {formatNumber(selectedPhoneDetails.maxStorageGb, " GB")}</p>
                    <p>Back Camera: {formatNumber(selectedPhoneDetails.backCameraMp, " MP")}</p>
                    <p>Front Camera: {formatNumber(selectedPhoneDetails.frontCameraMp, " MP")}</p>
                    <p>5G: {getConnectivityLabel(selectedPhoneDetails.has5G)}</p>
                    <p>NFC: {getConnectivityLabel(selectedPhoneDetails.hasNfc)}</p>
                    <p>WiFi: {getConnectivityLabel(selectedPhoneDetails.hasWifi)}</p>
                    <p>Bluetooth: {getConnectivityLabel(selectedPhoneDetails.hasBluetooth)}</p>
                  </div>
                  <p className="text-neutral-300">Processor: {selectedPhoneDetails.processor}</p>
                  <p className="text-neutral-300">OS: {selectedPhoneDetails.operatingSystem}</p>
                  <p className="text-neutral-300">SIM: {selectedPhoneDetails.simSupport}</p>
                  <p className="text-neutral-300">Release Date: {selectedPhoneDetails.releaseDate}</p>
                  <p className="text-neutral-300">Colors: {selectedPhoneDetails.colors}</p>
                  <p className="text-neutral-300">Storage Options: {selectedPhoneDetails.storageOptions}</p>
                </div>
              )}
            </aside>
          </div>
        </div>
      </section>

    </main>
  );
}