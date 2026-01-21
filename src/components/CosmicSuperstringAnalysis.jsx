const heroUrl = `${import.meta.env.BASE_URL}hero.jpg`;

return (
  <div style={{ minHeight: "100vh", background: "#0b0f14" }}>
    {/* HERO */}
    <div
      style={{
        height: "320px",
        backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.65), rgba(0,0,0,0.85)), url(${heroUrl})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        display: "flex",
        alignItems: "flex-end",
      }}
    >
      <div style={{ padding: "28px", color: "white", maxWidth: "1100px", width: "100%" }}>
        <h1 style={{ margin: 0, fontSize: "40px", fontWeight: 800 }}>Cosmic Superstring Constraints</h1>
        <p style={{ marginTop: "10px", marginBottom: 0, opacity: 0.9 }}>
          PTA upper-limit likelihood + affine-invariant ensemble MCMC + Web Worker acceleration.
        </p>
      </div>
    </div>

    {/* MAIN CONTENT */}
    <div style={{ maxWidth: "1100px", margin: "0 auto", padding: "24px" }}>
      {/* existing content here */}
    </div>
  </div>
);
