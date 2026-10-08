export default function ConfigError() {
  return (
    <main className="center">
      <div className="card narrow">
        <h1>Configuration incomplète</h1>
        <p className="muted">
          La variable d&apos;environnement <code>DASHBOARD_PASSWORD</code> n&apos;est pas définie. Le
          tableau de bord reste fermé tant qu&apos;elle n&apos;est pas configurée dans Vercel.
        </p>
      </div>
    </main>
  );
}
