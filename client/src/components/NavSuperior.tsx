// ============================================================
// Navegação superior partilhada entre as abas principais:
//   /        → Gestão de Extratos (faturas)
//   /saude   → Saúde da Empresa (análise financeira)
// ============================================================

import { Link, useLocation } from "wouter";
import { FileSpreadsheet, Activity } from "lucide-react";

const ABAS = [
  { rota: "/", label: "Gestão de Extratos", icon: FileSpreadsheet },
  { rota: "/saude", label: "Saúde da Empresa", icon: Activity },
];

export default function NavSuperior() {
  const [location] = useLocation();
  return (
    <nav className="bg-[#0b1f38] border-b border-[#1e3a5c] no-print">
      <div className="container flex items-center gap-1 overflow-x-auto">
        {ABAS.map(({ rota, label, icon: Icon }) => {
          const ativo = location === rota;
          return (
            <Link
              key={rota}
              href={rota}
              className={`flex items-center gap-2 px-4 py-3 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap
                ${ativo
                  ? "border-[#2563eb] text-white"
                  : "border-transparent text-blue-300 hover:text-white hover:border-blue-700"}`}
            >
              <Icon className="w-4 h-4" />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
