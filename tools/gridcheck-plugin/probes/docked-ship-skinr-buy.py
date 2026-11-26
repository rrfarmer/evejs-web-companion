from cosmetics.client.ships.feature_flag import are_skin_hub_offers_enabled
from eve.client.script.ui.cosmetics.ship.pages.store.buySkinDialogue import BuySkinDialogue
from localization import GetByLabel

prefix = 'UI/Personalization/ShipSkins/SKINR/'
paths = ('Studio/BuySkin', 'Store/Buy', 'Studio/ListingErrors/InsufficientFunds',
         'TargetedAtAnotherCharacter', 'TargetedAtAnotherOrganization')
labels = {path: GetByLabel(prefix + path) for path in paths}
labels['quantity'] = GetByLabel('UI/Common/Quantity')
labels['price'] = GetByLabel('UI/Market/Marketbase/Price')
labels['cancel'] = GetByLabel('UI/Common/Buttons/Cancel')

result = dict(station=session.stationid, offersEnabled=bool(are_skin_hub_offers_enabled()),
              windowID=BuySkinDialogue.default_windowID, caption=BuySkinDialogue.default_caption,
              labels=labels)
