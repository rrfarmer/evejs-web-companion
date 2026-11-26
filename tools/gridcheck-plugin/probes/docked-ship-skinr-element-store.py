import base64
import json
import zlib
from cosmetics.common.ships.skins.static_data.component import ComponentsDataLoader
from cosmetics.common.ships.skins.static_data.component_finish import ComponentFinish
from eve.client.script.ui.cosmetics.ship.const import SkinrPage
from eve.client.script.ui.cosmetics.ship.pages import current_page
from eve.client.script.ui.cosmetics.ship.pages.store.componentBrowser import MAX_NUM_PER_PAGE
from eve.client.script.ui.cosmetics.ship.pages.store.buyComponentDialogue import BuyComponentDialogue
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow
from eveProto.generated.eve_public.cosmetic.market.component.listing.api import api_pb2
from localization import GetByLabel

messages = {}
enums = {}

def visit(descriptor):
    if descriptor.full_name in messages:
        return
    fields = []
    messages[descriptor.full_name] = {'fields': fields}
    for field in descriptor.fields:
        row = dict(name=field.name, number=field.number, type=field.type, label=field.label)
        if field.containing_oneof:
            row['oneof'] = field.containing_oneof.name
        if field.message_type:
            row['typeName'] = field.message_type.full_name
            visit(field.message_type)
        if field.enum_type:
            row['typeName'] = field.enum_type.full_name
            enums[field.enum_type.full_name] = {'values': {value.name: value.number for value in field.enum_type.values}}
        fields.append(row)

for cls in (api_pb2.GetAllRequest, api_pb2.GetAllResponse,
            api_pb2.InitiatePurchaseListingRequest, api_pb2.InitiatePurchaseListingResponse):
    visit(cls.DESCRIPTOR)

items = {}
finishes = {ComponentFinish.MATTE: 'matte', ComponentFinish.SATIN: 'satin', ComponentFinish.GLOSS: 'gloss'}
for component_id, data in ComponentsDataLoader.get_components_data().items():
    if data.published:
        for item in data.component_item_data_by_type_id.values():
            if item.type_id:
                items[item.type_id] = [component_id, item.license_uses_granted, finishes.get(data.finish)]

window = ShipSKINRWindow.Open()
try:
    current_page.set_page_id(SkinrPage.STORE)
    page = window.store_page
    page.show_components()
    prefix = 'UI/Personalization/ShipSkins/SKINR/'
    paths = ('Studio/DesignElements', 'Studio/Nanocoatings', 'Studio/Metallics', 'Studio/Patterns',
             'Studio/BuyElement', 'Store/ActivateNow', 'ItemDeliveryNotice', 'FinishMatte', 'FinishSatin', 'FinishGloss')
    data = dict(station=session.stationid, pageSize=MAX_NUM_PER_PAGE, caption=BuyComponentDialogue.default_caption,
                labels={path: GetByLabel(prefix + path) for path in paths}, visible=bool(page.component_browser.display),
                sections=[child.name for child in page.component_browser.mainCont.children],
                samples={type_id: items[type_id] for type_id in (82957, 83060, 85404, 82340)},
                typeCount=len(items),
                catalogue=base64.b64encode(zlib.compress(json.dumps(items, separators=(',', ':')), 9)),
                schema=dict(messages=messages, enums=enums))
finally:
    current_page.set_page_id(SkinrPage.STUDIO)
    window.Close()

result = data
