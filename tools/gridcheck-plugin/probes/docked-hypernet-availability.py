from raffles.client import raffle_service
from raffles.common.util import is_kill_switch_enabled
svc = sm.GetService('raffleSvc')
result = dict(country=session.countryCode, region=raffle_service.boot.region,
              available=bool(svc.is_available), banned=bool(svc._is_banned),
              restricted=bool(svc._is_restricted),
              killSwitch=bool(is_kill_switch_enabled(svc.machoNet)),
              restrictedCountries=list(raffle_service.RESTRICTED_COUNTRIES))
