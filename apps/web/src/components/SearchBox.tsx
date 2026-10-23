import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { gql } from '../api';

interface Hit {
  id: string;
  title: string;
  workspaceName: string;
}

/** Title search across every workspace the user belongs to. */
export function SearchBox() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      gql<{ searchDocuments: Hit[] }>(`query($q: String!) { searchDocuments(query: $q, limit: 8) { id title workspaceName } }`, {
        q: text.slice(0, 100),
      })
        .then((d) => {
          if (cancelled) return;
          setHits(d.searchDocuments);
          setActive(0);
        })
        .catch(() => !cancelled && setHits([]));
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const go = (hit: Hit) => {
    setOpen(false);
    setQuery('');
    navigate(`/d/${hit.id}`);
  };

  return (
    <div className="search" ref={boxRef}>
      <input
        type="search"
        placeholder="Search documents…"
        aria-label="Search documents"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, hits.length - 1));
          else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
          else if (e.key === 'Enter' && hits[active]) go(hits[active]);
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && query.trim() && (
        <ul className="search-results" role="listbox">
          {hits.length === 0 ? (
            <li className="muted small">No matching documents</li>
          ) : (
            hits.map((hit, i) => (
              <li key={hit.id} role="option" aria-selected={i === active}>
                <button type="button" className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={() => go(hit)}>
                  <span>{hit.title}</span>
                  <span className="muted small">{hit.workspaceName}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
