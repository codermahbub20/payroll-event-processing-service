import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { EventDetailPage } from "./pages/EventDetailPage";
import { EventsListPage } from "./pages/EventsListPage";
import { SubmitEventPage } from "./pages/SubmitEventPage";

export default function App() {
  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <h1 className="app-title">Payroll Events</h1>
          <nav className="app-nav">
            <NavLink to="/submit">Submit</NavLink>
            <NavLink to="/events">Events</NavLink>
          </nav>
          <a
            href="/api/docs"
            target="_blank"
            rel="noreferrer"
            style={{ marginLeft: "auto", fontSize: 14 }}
          >
            API docs ↗
          </a>
        </div>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/events" replace />} />
          <Route path="/submit" element={<SubmitEventPage />} />
          <Route path="/events" element={<EventsListPage />} />
          <Route path="/events/:id" element={<EventDetailPage />} />
          <Route
            path="*"
            element={
              <div className="card empty">
                Page not found. <NavLink to="/events">Go to events</NavLink>
              </div>
            }
          />
        </Routes>
      </main>
    </>
  );
}
