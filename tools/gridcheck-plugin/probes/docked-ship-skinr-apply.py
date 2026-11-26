from eve.client.script.ui.cosmetics.ship import shipUtil
from localization import GetByLabel

prefix = 'UI/Personalization/ShipSkins/SKINR/Collection/'
state = shipUtil.get_active_ship_skin_state()
result = dict(station=session.stationid, ship=shipUtil.get_active_ship_item_id(),
              skinType=str(state.skin_type),
              labels={key: GetByLabel(prefix + key) for key in ('Apply', 'UnApply', 'ActivateAndApply', 'SkinApplyDisabledHint')})
