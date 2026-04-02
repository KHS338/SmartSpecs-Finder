"use client";

import { useState } from "react";

interface PhoneSource {
  id: string;
  name: string;
  price: number;
  url: string;
}

interface Message {
  role: "user" | "ai";
  text: string;
}

export default function Dashboard() {
  const [query, setQuery] = useState("");
  const [chat, setChat] = useState<Message[]>([]);
  const [recommendedPhones, setRecommendedPhones] = useState<PhoneSource[]>([]);
  const [isLoading, setIsLoading] = useState(false);

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
      
      // Update the UI with the actual metadata extracted from ChromaDB
      if (data.sources) {
        // Remove duplicates just in case the vector DB pulled overlapping chunks
        const uniquePhones = Array.from(
          new Map(data.sources.map((item: PhoneSource) => [item.url, item])).values()
        );
        setRecommendedPhones(uniquePhones as PhoneSource[]);
      }
    } catch (error) {
      setChat((prev) => [
        ...prev,
        { role: "ai", text: "Error connecting to the backend API. Is NestJS running?" },
      ]);
    } finally {
      setIsLoading(false);
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
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-neutral-700">
          {chat.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-neutral-500 space-y-4">
              <svg className="w-12 h-12 text-neutral-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>
              </svg>
              <p>Tell me your budget and requirements.<br/>e.g., "I need a gaming phone under 300k"</p>
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
          
          {recommendedPhones.length === 0 ? (
            <div className="border border-dashed border-neutral-800 rounded-2xl h-64 flex items-center justify-center text-neutral-600 bg-neutral-900/50">
              Matches will appear here during the conversation.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {recommendedPhones.map((phone, idx) => (
                <div key={idx} className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden hover:border-emerald-500/50 transition-colors group flex flex-col">
                  <div className="p-5 flex-1">
                    <h3 className="text-lg font-bold text-white mb-2 line-clamp-2">{phone.name}</h3>
                    <div className="inline-block bg-neutral-950 border border-neutral-700 rounded text-emerald-400 font-mono text-sm px-2 py-1 mb-4">
                      Rs {phone.price.toLocaleString()}
                    </div>
                  </div>
                  <div className="bg-neutral-950 p-4 border-t border-neutral-800 mt-auto">
                    <a 
                      href={phone.url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-neutral-400 hover:text-emerald-400 flex items-center justify-between transition-colors w-full"
                    >
                      View on PriceOye
                      <svg className="w-4 h-4 transform group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

    </main>
  );
}