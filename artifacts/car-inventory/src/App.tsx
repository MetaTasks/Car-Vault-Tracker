import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  getGetInventorySummaryQueryKey,
  getListVehiclesQueryKey,
  useDeleteVehicle,
  useGetInventorySummary,
  useImportVehicles,
  useListVehicles,
  useUpdateVehicle,
  type KeysStatus,
  type Vehicle,
} from '@workspace/api-client-react';
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  KeyRound,
  ListPlus,
  LoaderCircle,
  MapPin,
  Plus,
  ScanLine,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

type FilterKey = 'all' | 'on_site' | 'off_site';
type KeyFilter = 'all' | KeysStatus;
type ScanStage = 'camera' | 'review' | 'keys';

const normalizePlate = (value: string) => value.toUpperCase().replace(/[\s-]/g, '').trim();
const plateIsValid = (value: string) => /^[A-Z]{3}\d{2}[A-Z0-9]$/.test(normalizePlate(value));
const parseRegistrationList = (value: string) => value.split(/[\n,;]+/).flatMap((segment) => {
  const platePattern = /[A-Z]{3}[\s-]?\d{2}[\s-]?[A-Z0-9]/gi;
  const matches = segment.match(platePattern) ?? [];
  const leftovers = segment.replace(platePattern, ' ').trim().split(/\s+/).filter(Boolean);
  return [...matches, ...leftovers].map(normalizePlate);
});

function StatusPill({ onSite, registration }: { onSite: boolean; registration: string }) {
  return (
    <span className={`status-pill ${onSite ? 'status-present' : 'status-away'}`} data-testid={`status-presence-${registration}`}>
      <span className="status-dot" />
      {onSite ? 'On site' : 'Off site'}
    </span>
  );
}

function KeyLabel({ status }: { status: KeysStatus }) {
  if (status === 'in_vault') return <span className="key-label key-secure"><ShieldCheck size={14} /> In vault</span>;
  if (status === 'not_in_vault') return <span className="key-label key-out"><KeyRound size={14} /> Not in vault</span>;
  return <span className="key-label key-unknown"><CircleHelp size={14} /> Unknown</span>;
}

function Metric({ label, value, detail, icon: Icon, tone = '' }: { label: string; value?: number; detail: string; icon: typeof MapPin; tone?: string }) {
  return (
    <div className={`metric-card ${tone}`} data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
      <div className="metric-top"><span>{label}</span><Icon size={17} strokeWidth={1.8} /></div>
      <div className="metric-value">{value === undefined ? <span className="metric-skeleton" /> : value}</div>
      <div className="metric-detail">{detail}</div>
    </div>
  );
}

function Home() {
  const [search, setSearch] = useState('');
  const [presence, setPresence] = useState<FilterKey>('all');
  const [keyFilter, setKeyFilter] = useState<KeyFilter>('all');
  const [scanOpen, setScanOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState<{ created: number; existing: number; invalid: number } | null>(null);
  const [scanStage, setScanStage] = useState<ScanStage>('camera');
  const [plateInput, setPlateInput] = useState('');
  const [scannedPlate, setScannedPlate] = useState('');
  const [scanMessage, setScanMessage] = useState('');
  const [cameraError, setCameraError] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [filterMenu, setFilterMenu] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const queryClient = useQueryClient();
  const vehiclesQuery = useListVehicles();
  const summaryQuery = useGetInventorySummary();
  const allVehicles = vehiclesQuery.data ?? [];
  const vehicles = useMemo(() => allVehicles.filter((vehicle) => {
    const matchesSearch = !search.trim() || vehicle.registrationNumber.toLowerCase().includes(search.trim().toLowerCase());
    const matchesPresence = presence === 'all' || (presence === 'on_site' ? vehicle.onSite : !vehicle.onSite);
    const matchesKeys = keyFilter === 'all' || vehicle.keysStatus === keyFilter;
    return matchesSearch && matchesPresence && matchesKeys;
  }), [allVehicles, search, presence, keyFilter]);
  const summary = summaryQuery.data;

  const refreshInventory = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getListVehiclesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetInventorySummaryQueryKey() });
  }, [queryClient]);
  const updateVehicle = useUpdateVehicle({ mutation: { onSuccess: refreshInventory } });
  const deleteVehicle = useDeleteVehicle({ mutation: { onSuccess: refreshInventory } });
  const importVehicles = useImportVehicles({ mutation: { onSuccess: refreshInventory } });

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraReady(false);
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const startCamera = async () => {
    setCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera access is not available here. Enter the registration manually below.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraReady(true);
      }
    } catch {
      setCameraError('Camera permission was unavailable. You can still enter the plate manually.');
    }
  };

  useEffect(() => {
    if (scanOpen && scanStage === 'camera') void startCamera();
    else stopCamera();
    return () => stopCamera();
  }, [scanOpen, scanStage, stopCamera]);

  const submitPlate = (raw: string) => {
    const plate = normalizePlate(raw);
    if (!plateIsValid(plate)) {
      setScanMessage('Enter a Swedish registration in the format ABC123.');
      return;
    }
    setScanMessage('');
    setScannedPlate(plate);
    setPlateInput(plate);
    const found = allVehicles.find((item) => normalizePlate(item.registrationNumber) === plate);
    if (found) {
      if (found.onSite) {
        setScanStage('keys');
      } else {
        updateVehicle.mutate({ registrationNumber: found.registrationNumber, data: { onSite: true } }, {
          onSuccess: () => setScanStage('keys'),
          onError: () => {
            setScanMessage('Could not mark this vehicle on site. Try again.');
            void startCamera();
          },
        });
      }
    } else {
      setScanStage('review');
    }
  };

  const captureAndRead = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setCameraError('Camera is still starting. You can enter the plate manually.');
      return;
    }
    setOcrBusy(true);
    setScanMessage('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Unable to capture image');
      context.drawImage(video, 0, 0);
      stopCamera();
      const image = canvas.toDataURL('image/jpeg', 0.92);
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng');
      try {
        const result = await worker.recognize(image);
        const candidates = result.data.text.toUpperCase().match(/[A-Z]{3}[\s-]?\d{2}[\s-]?[A-Z0-9]/g) ?? [];
        const candidate = candidates.map(normalizePlate).find(plateIsValid);
        if (candidate) submitPlate(candidate);
        else {
          setScanMessage('We could not read a plate clearly. Try again or enter it manually.');
          void startCamera();
        }
      } finally {
        await worker.terminate();
      }
    } catch {
      setScanMessage('Plate reading could not start. Enter the registration manually.');
      void startCamera();
    } finally {
      setOcrBusy(false);
    }
  };

  const closeScan = () => {
    stopCamera();
    setScanOpen(false);
    setScanStage('camera');
    setPlateInput('');
    setScannedPlate('');
    setScanMessage('');
    setCameraError('');
  };

  const addScannedVehicle = () => {
    importVehicles.mutate({ data: { registrations: [scannedPlate] } }, {
      onSuccess: (result) => {
        refreshInventory();
        if (result.created + result.existing === 0) {
          setScanMessage('This registration could not be added. Check the plate and try again.');
          return;
        }
        updateVehicle.mutate({ registrationNumber: scannedPlate, data: { onSite: true } }, {
          onSuccess: () => setScanStage('keys'),
          onError: () => setScanMessage('Could not mark this vehicle on site. Try again.'),
        });
      },
      onError: () => setScanMessage('Could not add this vehicle right now. Please try again.'),
    });
  };

  const setScannedKeys = (status: KeysStatus) => {
    updateVehicle.mutate({ registrationNumber: scannedPlate, data: { keysStatus: status } }, {
      onSuccess: () => closeScan(),
      onError: () => setScanMessage('Could not update key status. Please try again.'),
    });
  };

  const importPasted = () => {
    const registrations = parseRegistrationList(importText);
    if (!registrations.length) {
      setImportResult({ created: 0, existing: 0, invalid: 0 });
      return;
    }
    importVehicles.mutate({ data: { registrations } }, {
      onSuccess: (result) => setImportResult(result),
    });
  };

  const filters = [
    { id: 'all' as const, label: 'All vehicles', count: summary?.total },
    { id: 'on_site' as const, label: 'On site', count: summary?.onSite },
    { id: 'off_site' as const, label: 'Off site', count: summary?.offSite },
  ];

  return (
    <main className="inventory-shell min-h-[100dvh]">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /><span /><span /></div>
          <div><div className="brand-name">LOT<span> / </span>KEEP</div><div className="brand-caption">YARD INVENTORY</div></div>
        </div>
        <div className="topbar-right">
          <span className="live-indicator"><i /> Yard view</span>
          <span className="topbar-date">{new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date())}</span>
        </div>
      </header>

      <div className="page-wrap">
        <section className="page-heading animate-arrive">
          <div>
            <p className="eyebrow">VEHICLE YARD <span>•</span> LIVE INVENTORY</p>
            <h1>Know what’s <em>here.</em></h1>
            <p className="heading-note">Every plate, every key. At a glance.</p>
          </div>
          <div className="heading-actions">
            <button className="button button-quiet" onClick={() => { setImportOpen(true); setImportResult(null); }} data-testid="button-import-list"><ListPlus size={17} /> Import list</button>
            <button className="button button-primary" onClick={() => { setScanOpen(true); setScanStage('camera'); }} data-testid="button-scan-plate"><ScanLine size={17} /> Scan a plate</button>
          </div>
        </section>

        <section className="metrics-row animate-arrive" aria-label="Inventory summary">
          <Metric label="Vehicles" value={summary?.total} detail="In inventory" icon={MapPin} tone="metric-total" />
          <Metric label="On site" value={summary?.onSite} detail={summary?.total ? `${Math.round((summary.onSite / summary.total) * 100)}% of fleet` : 'Currently in yard'} icon={CheckCircle2} tone="metric-green" />
          <Metric label="Off site" value={summary?.offSite} detail="Checked out" icon={ArrowUpRight} tone="metric-amber" />
          <Metric label="Keys in vault" value={summary?.keysInVault} detail="Secured" icon={ShieldCheck} tone="metric-slate" />
          <Metric label="Keys not in vault" value={summary?.keysNotInVault} detail={`${summary?.keysUnknown ?? '—'} unconfirmed`} icon={KeyRound} tone="metric-amber" />
        </section>

        <section className="inventory-panel animate-arrive" aria-label="Vehicle inventory">
          <div className="inventory-toolbar">
            <div className="inventory-title">
              <h2>Fleet register</h2>
              <span className="count-chip" data-testid="text-filtered-count">{vehicles.length}</span>
            </div>
            <div className="toolbar-controls">
              <label className="search-box">
                <Search size={17} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a registration" aria-label="Search registrations" data-testid="input-search-vehicles" />
                {search && <button onClick={() => setSearch('')} aria-label="Clear search" data-testid="button-clear-search"><X size={15} /></button>}
              </label>
              <div className="filter-dropdown">
                <button className={`button button-filter ${filterMenu ? 'is-open' : ''}`} onClick={() => setFilterMenu((value) => !value)} aria-expanded={filterMenu} data-testid="button-more-filters">
                  <span className="filter-icon">≡</span> Filters <ChevronDown size={14} />
                </button>
                {filterMenu && <div className="filter-popover">
                  <p>KEY LOCATION</p>
                  {([
                    ['all', 'Any key status'],
                    ['in_vault', 'In vault'],
                    ['not_in_vault', 'Not in vault'],
                    ['unknown', 'Unknown'],
                  ] as [KeyFilter, string][]).map(([id, label]) => (
                    <button key={id} className={keyFilter === id ? 'selected-filter' : ''} onClick={() => { setKeyFilter(id); setFilterMenu(false); }} data-testid={`filter-keys-${id}`}>
                      <span>{label}</span>{keyFilter === id && <Check size={15} />}
                    </button>
                  ))}
                </div>}
              </div>
            </div>
          </div>
          {(updateVehicle.isError || deleteVehicle.isError) && <div className="mutation-notice" role="alert"><AlertCircle size={15} />One change could not be saved. Try that action again.</div>}

          <nav className="presence-tabs" aria-label="Presence filter">
            {filters.map((filter) => (
              <button key={filter.id} className={`presence-tab ${presence === filter.id ? 'active' : ''}`} onClick={() => setPresence(filter.id)} data-testid={`filter-presence-${filter.id}`}>
                {filter.label}<span>{filter.count ?? '—'}</span>
              </button>
            ))}
          </nav>

          {vehiclesQuery.isLoading ? (
            <div className="skeleton-list" aria-label="Loading vehicles">
              {[0, 1, 2, 3].map((item) => <div className="skeleton-row" key={item}><span /><span /><span /><span /></div>)}
            </div>
          ) : vehiclesQuery.isError ? (
            <div className="state-message state-error" role="alert">
              <AlertCircle size={22} /><div><strong>Inventory is unavailable</strong><p>Check your connection and try again.</p></div>
              <button className="button button-quiet" onClick={() => { void vehiclesQuery.refetch(); void summaryQuery.refetch(); }} data-testid="button-retry-inventory">Try again</button>
            </div>
          ) : vehicles.length === 0 ? (
            <div className="empty-state">
              <div className="empty-symbol"><Search size={23} /></div>
              <h3>{search || presence !== 'all' || keyFilter !== 'all' ? 'No vehicles match' : 'A clear lot to start'}</h3>
              <p>{search || presence !== 'all' || keyFilter !== 'all' ? 'Try another plate or adjust your filters.' : 'Scan a plate or import a register to see every vehicle here.'}</p>
              {!(search || presence !== 'all' || keyFilter !== 'all') && <button className="button button-primary" onClick={() => setScanOpen(true)} data-testid="button-scan-empty"><ScanLine size={16} /> Scan first vehicle</button>}
              {(search || presence !== 'all' || keyFilter !== 'all') && <button className="text-action" onClick={() => { setSearch(''); setPresence('all'); setKeyFilter('all'); }} data-testid="button-reset-filters">Clear all filters</button>}
            </div>
          ) : (
            <div className="vehicle-list" data-testid="list-vehicles">
              <div className="vehicle-list-head"><span>REGISTRATION</span><span>PRESENCE</span><span>KEY LOCATION</span><span>LAST SEEN</span><span /></div>
              {vehicles.map((vehicle) => (
                <VehicleRow key={vehicle.registrationNumber} vehicle={vehicle} pending={updateVehicle.isPending} onPresence={() => updateVehicle.mutate({ registrationNumber: vehicle.registrationNumber, data: { onSite: !vehicle.onSite } })} onKeys={(keysStatus) => updateVehicle.mutate({ registrationNumber: vehicle.registrationNumber, data: { keysStatus } })} onDelete={() => {
                  if (window.confirm(`Remove ${vehicle.registrationNumber} from the inventory?`)) deleteVehicle.mutate({ registrationNumber: vehicle.registrationNumber });
                }} deletePending={deleteVehicle.isPending} />
              ))}
            </div>
          )}
          <div className="panel-foot">
            <span><i /> Inventory updates as staff check vehicles in and out</span>
            {summary?.recentActivity?.length ? <span className="activity-foot"><Clock3 size={13} /> Updated {relativeTime(summary.recentActivity[0].updatedAt)}</span> : <span>Ready for today</span>}
          </div>
        </section>
        <footer className="page-footer"><span>LOTKEEP <i>·</i> YARD OPERATIONS</span><span>Quick answers, right where you need them.</span></footer>
      </div>

      {scanOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeScan(); }}>
        <section className="modal-card scan-modal" role="dialog" aria-modal="true" aria-labelledby="scan-title">
          <div className="modal-head">
            <div><p className="eyebrow">QUICK CHECK-IN</p><h2 id="scan-title">{scanStage === 'keys' ? 'Where are the keys?' : scanStage === 'review' ? 'New to this yard' : 'Read a registration'}</h2></div>
            <button className="icon-button" onClick={closeScan} aria-label="Close scanner" data-testid="button-close-scanner"><X size={19} /></button>
          </div>
          {scanStage === 'camera' && <div className="scan-content">
            <div className="camera-frame">
              <video ref={videoRef} muted playsInline aria-label="Camera plate view" data-testid="video-plate-camera" />
              <div className="camera-overlay"><span /><span /></div>
              {!cameraReady && <div className="camera-placeholder"><ScanLine size={28} /><span>Frame the registration plate</span></div>}
              {ocrBusy && <div className="ocr-cover"><LoaderCircle className="spin" size={26} /><span>Reading plate</span></div>}
            </div>
            {cameraError && <p className="inline-notice"><AlertCircle size={15} />{cameraError}</p>}
            {scanMessage && <p className="inline-notice notice-warning"><AlertCircle size={15} />{scanMessage}</p>}
            <button className="button button-primary button-wide" disabled={ocrBusy} onClick={() => void captureAndRead()} data-testid="button-capture-plate">{ocrBusy ? <LoaderCircle className="spin" size={17} /> : <ScanLine size={17} />} Capture plate</button>
            <div className="manual-divider"><span />or enter it manually<span /></div>
            <div className="manual-entry">
              <input value={plateInput} onChange={(event) => setPlateInput(event.target.value.toUpperCase())} maxLength={8} placeholder="ABC 123" aria-label="Registration number" data-testid="input-manual-registration" onKeyDown={(event) => { if (event.key === 'Enter') submitPlate(plateInput); }} />
              <button className="button button-secondary" onClick={() => submitPlate(plateInput)} data-testid="button-submit-registration">Continue <ArrowDownLeft size={15} /></button>
            </div>
            <p className="helper-copy">Swedish plates use three letters and three characters.</p>
          </div>}
          {scanStage === 'review' && <div className="scan-content review-content">
            <div className="plate-preview">{scannedPlate}</div>
            <div className="review-note"><div className="review-icon"><Plus size={18} /></div><div><strong>Not in the register yet</strong><p>Add it now and mark it on site. You can confirm the key location next.</p></div></div>
            {scanMessage && <p className="inline-notice notice-warning"><AlertCircle size={15} />{scanMessage}</p>}
            <button className="button button-primary button-wide" disabled={importVehicles.isPending || updateVehicle.isPending} onClick={addScannedVehicle} data-testid="button-add-scanned-vehicle">{importVehicles.isPending || updateVehicle.isPending ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} Add vehicle & continue</button>
            <button className="text-action" onClick={() => { setScanStage('camera'); setScanMessage(''); }} data-testid="button-rescan-plate">Try another plate</button>
          </div>}
          {scanStage === 'keys' && <div className="scan-content keys-content">
            <div className="plate-preview">{scannedPlate}</div>
            <p className="question-copy">Are this vehicle’s keys secured in the locked vault?</p>
            {scanMessage && <p className="inline-notice notice-warning"><AlertCircle size={15} />{scanMessage}</p>}
            <button className="key-choice key-choice-yes" disabled={updateVehicle.isPending} onClick={() => setScannedKeys('in_vault')} data-testid="button-keys-in-vault"><ShieldCheck size={21} /><span><strong>Yes, in the vault</strong><small>Keys are secured</small></span><ArrowDownLeft size={17} /></button>
            <button className="key-choice key-choice-no" disabled={updateVehicle.isPending} onClick={() => setScannedKeys('not_in_vault')} data-testid="button-keys-not-in-vault"><KeyRound size={21} /><span><strong>No, not in the vault</strong><small>Keys are elsewhere</small></span><ArrowDownLeft size={17} /></button>
            <button className="text-action" onClick={closeScan} data-testid="button-skip-key-check">Leave key status unchanged</button>
          </div>}
        </section>
      </div>}

      {importOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setImportOpen(false); }}>
        <section className="modal-card import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <div className="modal-head">
            <div><p className="eyebrow">BULK ADD</p><h2 id="import-title">Import registrations</h2></div>
            <button className="icon-button" onClick={() => setImportOpen(false)} aria-label="Close import" data-testid="button-close-import"><X size={19} /></button>
          </div>
          {importResult ? <div className="import-results" data-testid="status-import-results">
            <div className="result-check"><Check size={24} /></div>
            <h3>Register updated</h3>
            <div className="result-numbers">
              <div><strong>{importResult.created}</strong><span>Added</span></div><div><strong>{importResult.existing}</strong><span>Already listed</span></div><div><strong>{importResult.invalid}</strong><span>Couldn’t read</span></div>
            </div>
            <button className="button button-primary button-wide" onClick={() => setImportOpen(false)} data-testid="button-done-import">Back to inventory</button>
          </div> : <div className="import-body">
            <p>Paste one or more Swedish registrations. Separate plates with spaces, commas or new lines.</p>
            <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={'ABC123\nDEF456\nGHI789'} rows={7} aria-label="Registration list" data-testid="textarea-import-registrations" />
            <div className="import-hint"><span>{parseRegistrationList(importText).length} registrations detected</span><span>Up to 1,000 at a time</span></div>
            {importVehicles.isError && <p className="inline-notice notice-warning"><AlertCircle size={15} />Import failed. Check the list and try again.</p>}
            <button className="button button-primary button-wide" disabled={!importText.trim() || importVehicles.isPending} onClick={importPasted} data-testid="button-submit-import">{importVehicles.isPending ? <LoaderCircle className="spin" size={17} /> : <ListPlus size={17} />} Import registrations</button>
          </div>}
        </section>
      </div>}
    </main>
  );
}

function VehicleRow({ vehicle, pending, onPresence, onKeys, onDelete, deletePending }: { vehicle: Vehicle; pending: boolean; onPresence: () => void; onKeys: (status: KeysStatus) => void; onDelete: () => void; deletePending: boolean }) {
  const [keyMenuOpen, setKeyMenuOpen] = useState(false);
  return (
    <article className={`vehicle-row ${vehicle.onSite ? 'vehicle-on-site' : ''}`} data-testid={`row-vehicle-${vehicle.registrationNumber}`}>
      <div className="plate-cell"><span className="plate-mini">{vehicle.registrationNumber}</span><span className="mobile-last-seen">{relativeTime(vehicle.updatedAt)}</span></div>
      <div className="presence-cell">
        <button className="row-action" disabled={pending} onClick={onPresence} aria-label={`Mark ${vehicle.registrationNumber} ${vehicle.onSite ? 'off site' : 'on site'}`} data-testid={`button-toggle-presence-${vehicle.registrationNumber}`}><StatusPill onSite={vehicle.onSite} registration={vehicle.registrationNumber} /><ChevronDown size={13} /></button>
      </div>
      <div className="keys-cell">
        <button className="row-action" disabled={pending} onClick={() => setKeyMenuOpen((value) => !value)} aria-expanded={keyMenuOpen} data-testid={`button-key-status-${vehicle.registrationNumber}`}><KeyLabel status={vehicle.keysStatus} /><ChevronDown size={13} /></button>
        {keyMenuOpen && <div className="key-menu">
          {([
            ['in_vault', 'In vault'],
            ['not_in_vault', 'Not in vault'],
            ['unknown', 'Unknown'],
          ] as [KeysStatus, string][]).map(([status, label]) => <button key={status} onClick={() => { onKeys(status); setKeyMenuOpen(false); }} data-testid={`button-set-key-${status}-${vehicle.registrationNumber}`}><KeyLabel status={status} /></button>)}
        </div>}
      </div>
      <div className="last-seen-cell"><span>{relativeTime(vehicle.updatedAt)}</span>{vehicle.onSiteAt && vehicle.onSite && <small>Arrived {new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(vehicle.onSiteAt))}</small>}</div>
      <div className="row-delete-cell"><button className="icon-button delete-button" disabled={deletePending} onClick={onDelete} aria-label={`Remove ${vehicle.registrationNumber}`} data-testid={`button-delete-${vehicle.registrationNumber}`}><Trash2 size={16} /></button></div>
    </article>
  );
}

function relativeTime(dateValue: string) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return '—';
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days}d ago`;
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
