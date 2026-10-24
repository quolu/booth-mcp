# 商品の公開状態

公開状態の変更はbooth_update_itemのstateで要求する。BoothClientが公式画面と同じstate_eventへ変換し、保存後のstateが要求と一致した場合だけ成功にする。通常の文面更新では公開状態を変更しない。

2026-09-21、stateだけのPATCHはHTTP成功でも下書きのままになることを実測。BOOTH公式商品編集画面の実装から、公開はpublish、非公開はto_privateのイベントで行うことを確認した。

根拠: https://asset.booth.pm/assets/17dfa98e1fb157517cf6.js （取得2026-09-21、商品編集画面の公式配信物）。6件のfocused testで送信内容・通常更新の維持・保存不一致のエラーを確認する。入口はnode --test booth-mcp/tests/item-state.test.js。
