from eve.client.script.ui.shared.neocom.wallet.panels.personal.plex import vault_actions
from eve.client.script.ui.shared.neocom.wallet.tabs.plexTab import PlexTab
from localization import GetByLabel
from plex.client.api.repository import get_repository


def observe():
    class Label(object):
        def SetText(self, text):
            self.text = text

        def SetHint(self, hint):
            self.hint = hint

    class Tile(object):
        def __init__(self):
            self.bottomLabel = Label()
            self.failed = False

        def failed_to_load_plex_balance(self):
            self.failed = True

    tile = Tile()
    rows = []
    try:
        balance = get_repository().get_balance()
        balance_error = None
    except Exception as error:
        balance = None
        balance_error = str(error)
    for value in [0, 1234, balance]:
        if value is not None:
            PlexTab._set_balance.__func__(tile, value)
            rows.append([value, tile.bottomLabel.text])
    PlexTab._set_balance_error.__func__(tile)
    return dict(station=session.stationid, balance=balance, balanceError=balance_error,
                rows=rows, unavailable=[tile.bottomLabel.text, tile.bottomLabel.hint, tile.failed],
                buy=[GetByLabel('UI/Wallet/WalletWindow/BuyPlex'),
                     GetByLabel('UI/VirtualGoodsStore/Buttons/BuyPlex')],
                actions=[button.LABEL_TEXT for button in (vault_actions.SellPLEXButton,
                         vault_actions.OmegaTimeButton, vault_actions.MultipleTrainingButton,
                         vault_actions.OpenNESButton, vault_actions.BuyPLEXButton)])


result = observe()
