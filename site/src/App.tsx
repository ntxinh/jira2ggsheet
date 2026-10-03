import Nav from "./components/Nav";
import Hero from "./components/Hero";
import Marquee from "./components/Marquee";
import Bento from "./components/Bento";
import Pricing from "./components/Pricing";
import Footer from "./components/Footer";

export default function App() {
  return (
    <div className="relative min-h-screen overflow-x-clip bg-[#050505] font-sans text-white antialiased">
      {/* ambient mesh gradients bleeding from the edges */}
      <div aria-hidden className="pointer-events-none fixed inset-0">
        <div className="absolute -top-[20%] -left-[15%] h-[55vmax] w-[55vmax] animate-blob-a rounded-full bg-neon-cyan/15 blur-[140px]" />
        <div className="absolute top-[30%] -right-[20%] h-[60vmax] w-[60vmax] animate-blob-b rounded-full bg-neon-purple/15 blur-[160px]" />
        <div className="absolute -bottom-[25%] left-[20%] h-[50vmax] w-[50vmax] animate-blob-c rounded-full bg-neon-orange/10 blur-[150px]" />
      </div>

      <Nav />
      <main className="relative">
        <Hero />
        <Marquee />
        <Bento />
        <Pricing />
      </main>
      <Footer />
    </div>
  );
}
