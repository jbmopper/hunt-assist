'use client';

import Link from 'next/link';
import trip from '@/lib/trip-brief.json';

export default function TripBriefPage() {
  return (
    <main className="trip-brief-shell">
      <header className="trip-brief-hero">
        <div>
          <span className="trip-kicker">HUNT ASSIST / FIELD BRIEF</span>
          <h1>{trip.title}</h1>
          <p>{trip.subtitle} / prepared {trip.prepared}</p>
        </div>
        <nav className="trip-brief-actions" aria-label="Trip brief actions">
          <Link href="/#bear-targets">Back to map</Link>
          <a href="/data/be012o1r-field-packet.pdf" download>Field PDF</a>
          <a href="/data/be012o1r-targets.gpx" download>GPX</a>
          <button type="button" onClick={() => window.print()}>Print / save PDF</button>
        </nav>
      </header>

      <section className="trip-legal-posture">
        <strong>Planning posture</strong>
        <p>{trip.stance}</p>
      </section>

      <section className="trip-hunt-strip" aria-label="Hunt details">
        <div><span>Hunt</span><strong>{trip.hunt.code}</strong></div>
        <div><span>Season</span><strong>{trip.hunt.season}</strong></div>
        <div><span>Trip</span><strong>{trip.hunt.tripDates}</strong></div>
        <div><span>Method</span><strong>{trip.hunt.method}</strong></div>
      </section>

      <section className="trip-section">
        <div className="trip-section-heading">
          <span>01</span><div><h2>Run of trip</h2><p>Two Rifle nights, then the Meeker loop.</p></div>
        </div>
        <div className="trip-itinerary">
          {trip.itinerary.map((day) => (
            <article key={day.day}>
              <span>{day.day}</span>
              <h3>{day.title}</h3>
              <p>{day.plan}</p>
              <dl>
                <div><dt>Sleep</dt><dd>{day.sleep}</dd></div>
                <div><dt>Legal hinge</dt><dd>{day.decision}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section className="trip-section">
        <div className="trip-section-heading">
          <span>02</span><div><h2>Hard legal rules</h2><p>Requirements, not extra caution margins.</p></div>
        </div>
        <div className="trip-rule-grid">
          {trip.legalRules.map((item) => (
            <article key={item.label}>
              <span>{item.label}</span>
              <p>{item.rule}</p>
              <strong>{item.fieldAction}</strong>
            </article>
          ))}
        </div>
      </section>

      <section className="trip-section">
        <div className="trip-section-heading">
          <span>03</span><div><h2>Camp and charge cards</h2><p>Legal status first; access judgment stays yours.</p></div>
        </div>
        <div className="trip-camp-grid">
          {trip.camps.map((camp) => (
            <article key={camp.name} className={camp.fit === 'INELIGIBLE' ? 'trip-card-stop' : ''}>
              <span>{camp.fit}</span>
              <h3>{camp.name}</h3>
              <p><strong>Place:</strong> {camp.location}</p>
              <p><strong>Authority:</strong> {camp.legal}</p>
              <p><strong>Food:</strong> {camp.food}</p>
              <small>{camp.note}</small>
            </article>
          ))}
        </div>
        <div className="trip-charge-row">
          {trip.charging.map((charger) => (
            <article key={charger.name}>
              <span>CHARGE</span><h3>{charger.name}</h3><p>{charger.address}</p><small>{charger.detail}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="trip-section">
        <div className="trip-section-heading">
          <span>04</span><div><h2>Scout cards</h2><p>Rule-screen starts; exact occupied point still controls.</p></div>
        </div>
        <p className="trip-scout-note">These are map-generated scout anchors, not automatic shooting positions. Confirm public access, the true facility/road boundary, current signs, target identity, and a safe backstop before using one.</p>
        <div className="trip-scout-grid">
          {trip.scoutCards.map((card) => (
            <article key={card.target}>
              <h3>{card.target}</h3>
              <small>Base: {card.camp}</small>
              {card.options.map((option) => (
                <div key={option.id}>
                  <strong>{option.id} / {option.name}</strong>
                  <code>{option.coordinates}</code>
                  <span>{option.sourceDistance}</span>
                  <span>{option.ruleRoute}</span>
                  <span>{option.mapSignal}</span>
                </div>
              ))}
            </article>
          ))}
        </div>
      </section>

      <section className="trip-section trip-field-section">
        <div>
          <div className="trip-section-heading">
            <span>05</span><div><h2>Field decision</h2><p>Fast yes/no screen.</p></div>
          </div>
          <ul className="trip-decision-list">
            {trip.goNoGo.map((item) => <li key={item}>{item}</li>)}
          </ul>
          <h3>Pack before departure</h3>
          <ul className="trip-checklist">
            {trip.checklist.map((item) => <li key={item}><span aria-hidden="true" />{item}</li>)}
          </ul>
        </div>
        <aside>
          <h3>Contacts</h3>
          <dl>
            {trip.contacts.map((contact) => (
              <div key={contact.label}><dt>{contact.label}</dt><dd>{contact.value}</dd></div>
            ))}
          </dl>
          <h3>Official sources</h3>
          <ol>
            {trip.sources.map((source) => (
              <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.label}</a></li>
            ))}
          </ol>
          <p className="trip-version">Prepared {trip.prepared}. Posted orders, closures, property boundaries, and your physical license control over this brief.</p>
        </aside>
      </section>
    </main>
  );
}
