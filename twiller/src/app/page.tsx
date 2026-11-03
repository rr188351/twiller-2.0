import Landing from "@/components/Landing";
import Mainlayout from "@/components/layout/Mainlayout";
import { AuthProvider, useAuth } from "@/context/AuthContext";
// Internship Feature 4 (phase 1) - device-local language preference. The
// provider wraps the whole app so every component can call useLanguage(),
// and it touches NO backend/auth logic (localStorage only).
import { LanguageProvider } from "@/context/LanguageContext";
import Image from "next/image";

export default function Home() {

  return (
    <LanguageProvider>
      <AuthProvider>
        <Mainlayout>
          {" "}
          <Landing />
        </Mainlayout>
      </AuthProvider>
    </LanguageProvider>
  );
}
