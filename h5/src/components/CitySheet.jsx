import { useEffect, useState } from 'react';
import { citiesOf, provinceOf, regionProvinces } from '../lib/city.js';

export default function CitySheet({ open, city, onClose, onPick, allowProvince = true }) {
  const [prov, setProv] = useState(() => provinceOf(city) || regionProvinces()[0]);

  useEffect(() => {
    if (open) setProv(provinceOf(city) || regionProvinces()[0]);
  }, [open, city]);

  if (!open) return null;

  const cities = citiesOf(prov);

  return (
    <div className="csheet on">
      <div className="cs-mask" onClick={onClose} role="presentation" />
      <div className="cs-panel">
        <div className="cs-h">
          选择城市
          <button type="button" className="cs-x" onClick={onClose}>
            ✕ 关闭
          </button>
        </div>
        <div className="cs-body">
          <div className="cs-prov">
            {regionProvinces().map((p) => (
              <a
                key={p}
                href="#prov"
                className={p === prov ? 'on' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  setProv(p);
                }}
              >
                {p}
              </a>
            ))}
          </div>
          <div className="cs-cities">
            {allowProvince ? (
              <a
                href="#all"
                className={'allp' + (city === prov ? ' on' : '')}
                onClick={(e) => {
                  e.preventDefault();
                  onPick(prov);
                }}
              >
                {prov}全省
              </a>
            ) : null}
            {cities.map((c) => (
              <a
                key={c}
                href="#city"
                className={c === city ? 'on' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  onPick(c);
                }}
              >
                {c}
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
