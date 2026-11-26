from carbonui.primitives.container import Container
from cosmetics.client.ships.skins.live_data.skin_listing_buyer_fee import ListingBuyerFee
from eve.client.script.ui.cosmetics.ship.controls.buyerFee import BuySKINBuyerFee
from eve.client.script.ui.cosmetics.ship.pages.store import buySkinDialogue
from localization import GetByLabel


class FixtureQuote(object):

    def __init__(self):
        self.target = self
        self.target_id = session.corpid
        self.listing = self

    def get_buyer_fee_for_listing(self, listing):
        return ListingBuyerFee(5800, 1000419), None


prefix = 'UI/Personalization/ShipSkins/SKINR/'
paths = ('BrandManagerListing', 'BuyerEverMarkFee', 'BuyersFeeHint', 'BrandManagerListingInfo')
fixture = FixtureQuote()
parent = Container()
panel = BuySKINBuyerFee(parent=parent)
original_service = buySkinDialogue.get_ship_skin_trading_svc
observations = []
try:
    buySkinDialogue.get_ship_skin_trading_svc = lambda: fixture
    panel.amount = 0
    zero_visible = bool(panel.display)
    for quantity in (1, 2, 4):
        fixture.purchase_quantity = quantity
        panel.amount = buySkinDialogue.BuySkinDialogue.get_buyer_fee_amount(fixture)
        observations.append(dict(quantity=quantity, amount=panel.amount, visible=bool(panel.display),
                                 text=panel.amount_label.text))
finally:
    buySkinDialogue.get_ship_skin_trading_svc = original_service
    parent.Close()

result = dict(station=session.stationid, zeroVisible=zero_visible, samples=observations,
              labels={path: GetByLabel(prefix + path) for path in paths},
              currency=GetByLabel('UI/Wallet/WalletWindow/EM'))
