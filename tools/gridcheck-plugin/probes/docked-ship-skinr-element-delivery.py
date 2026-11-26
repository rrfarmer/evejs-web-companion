import datetime
import uuid

from cosmetics.client.ships.skins.static_data.component_listing import ComponentListing
from cosmetics.common.ships.skins.util import Currency
from eve.client.script.ui.cosmetics.ship.pages.store.buyComponentDialogue import BuyComponentDialogue

listing = ComponentListing(uuid.uuid4(), datetime.datetime.now() + datetime.timedelta(days=1),
                           Currency.ISK, 1, 2, 85404, 3, 0)
dialogue = BuyComponentDialogue.Open(listing=listing)
try:
    active = bool(dialogue.activate_now_checkbox.checked)
    notice_before = bool(dialogue.item_delivery_notice.display)
    dialogue.activate_now_checkbox.SetChecked(False)
    observation = dict(station=session.stationid, activeByDefault=active,
                       noticeBefore=notice_before, noticeAfter=bool(dialogue.item_delivery_notice.display),
                       notice=dialogue.item_delivery_notice.noticeLabel.text,
                       canBuy=dialogue.is_allowed_to_purchase,
                       item=listing.component_item_type_id, bundle=listing.bundle_size)
finally:
    dialogue.Close()

result = observation
