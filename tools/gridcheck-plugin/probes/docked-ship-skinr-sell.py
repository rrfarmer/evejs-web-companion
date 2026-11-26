from cosmetics.client.shipSkinTradingSvc import get_ship_skin_trading_svc
from cosmetics.common.ships.skins.static_data import trading_const
from cosmetics.common.ships.skins.trading_util import get_maximum_concurrent_skin_listings
from eve.client.script.ui.cosmetics.ship import tradingUtil
from localization import GetByLabel

service = get_ship_skin_trading_svc()
durations = tradingUtil.get_sell_duration_options()
fees, fee_error = service.get_broker_fees_per_duration()
tax, tax_error = service.get_tax_rate()
skills = trading_const.max_concurrent_listings_skills
prefix = 'UI/Personalization/ShipSkins/SKINR/'
result = dict(station=session.stationid, durations=durations, availability=tradingUtil.get_sell_availability_options(),
              fees=dict((str(seconds), fee) for seconds, fee in (fees or {}).items()),
              tax=tax, feeError=str(fee_error), taxError=str(tax_error),
              limits=dict((str(skill), [get_maximum_concurrent_skin_listings(
                  lambda skill_id: level if skill_id == skill else 0) for level in range(6)]) for skill in skills),
              labels=[GetByLabel(prefix + key) for key in ('SellSkin', 'ListingCost', 'ServiceFee', 'TotalProfit')])
