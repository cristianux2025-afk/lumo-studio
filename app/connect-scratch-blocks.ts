/*
 * Scratch Blocks ↔ Scratch VM menu bridge.
 * Derived from Scratch GUI's block-menu bridge (AGPL-3.0-only), then adapted
 * for Lumo Studio's standalone Scratch Blocks workspace. See NOTICE.md.
 */

export function connectScratchBlocks(ScratchBlocks: any, vm: any) {
  const menuBlock = (name: string, options: () => string[][], category: string, start: string[][] = []) => ({
    message0: "%1",
    args0: [{type: "field_dropdown", name, options: () => start.concat(options())}],
    inputsInline: true,
    output: "String",
    outputShape: ScratchBlocks.OUTPUT_SHAPE_ROUND,
    extensions: [`colours_${category}`],
  });
  const safeInit = (type: string, callback: (block: any) => void) => {
    if (!ScratchBlocks.Blocks[type]) ScratchBlocks.Blocks[type] = {};
    ScratchBlocks.Blocks[type].init = function () { callback(this); };
  };
  const originals = () => (vm.runtime?.targets ?? []).filter((target: any) => target.isOriginal !== false);
  const spriteOptions = () => originals()
    .filter((target: any) => !target.isStage && target !== vm.editingTarget)
    .map((target: any) => [target.sprite?.name ?? "Objeto", target.sprite?.name ?? "Objeto"]);
  const nonEmpty = (items: string[][]) => items.length ? items : [["", ""]];
  const costumes = () => nonEmpty(vm.editingTarget?.getCostumes?.()?.map((costume: any) => [costume.name, costume.name]) ?? []);
  const sounds = () => nonEmpty(vm.editingTarget?.getSounds?.()?.map((sound: any) => [sound.name, sound.name]) ?? []);
  const stageCostumes = () => nonEmpty(vm.runtime?.getTargetForStage?.()?.getCostumes?.()?.map((costume: any) => [costume.name, costume.name]) ?? []);

  safeInit("sound_sounds_menu", block => block.jsonInit(menuBlock("SOUND_MENU", sounds, "sounds")));
  safeInit("looks_costume", block => block.jsonInit(menuBlock("COSTUME", costumes, "looks")));
  safeInit("looks_backdrops", block => {
    const extras = [
      [ScratchBlocks.ScratchMsgs.translate("LOOKS_NEXTBACKDROP", "siguiente fondo"), "next backdrop"],
      [ScratchBlocks.ScratchMsgs.translate("LOOKS_PREVIOUSBACKDROP", "fondo anterior"), "previous backdrop"],
      [ScratchBlocks.ScratchMsgs.translate("LOOKS_RANDOMBACKDROP", "fondo al azar"), "random backdrop"],
    ];
    block.jsonInit(menuBlock("BACKDROP", () => stageCostumes().concat(extras), "looks"));
  });
  safeInit("event_whenbackdropswitchesto", block => block.jsonInit({
    message0: ScratchBlocks.Msg.EVENT_WHENBACKDROPSWITCHESTO,
    args0: [{type: "field_dropdown", name: "BACKDROP", options: stageCostumes}],
    extensions: ["colours_event", "shape_hat"],
  }));
  safeInit("motion_pointtowards_menu", block => block.jsonInit(menuBlock("TOWARDS", spriteOptions, "motion", [
    [ScratchBlocks.ScratchMsgs.translate("MOTION_POINTTOWARDS_POINTER", "puntero del ratón"), "_mouse_"],
    [ScratchBlocks.ScratchMsgs.translate("MOTION_POINTTOWARDS_RANDOM", "dirección al azar"), "_random_"],
  ])));
  safeInit("motion_goto_menu", block => block.jsonInit(menuBlock("TO", spriteOptions, "motion", [
    [ScratchBlocks.ScratchMsgs.translate("MOTION_GOTO_RANDOM", "posición al azar"), "_random_"],
    [ScratchBlocks.ScratchMsgs.translate("MOTION_GOTO_POINTER", "puntero del ratón"), "_mouse_"],
  ])));
  safeInit("motion_glideto_menu", block => block.jsonInit(menuBlock("TO", spriteOptions, "motion", [
    [ScratchBlocks.ScratchMsgs.translate("MOTION_GLIDETO_RANDOM", "posición al azar"), "_random_"],
    [ScratchBlocks.ScratchMsgs.translate("MOTION_GLIDETO_POINTER", "puntero del ratón"), "_mouse_"],
  ])));
  safeInit("sensing_of_object_menu", block => block.jsonInit(menuBlock("OBJECT", spriteOptions, "sensing", [
    [ScratchBlocks.ScratchMsgs.translate("SENSING_OF_STAGE", "Escenario"), "_stage_"],
  ])));
  safeInit("sensing_distancetomenu", block => block.jsonInit(menuBlock("DISTANCETOMENU", spriteOptions, "sensing", [
    [ScratchBlocks.ScratchMsgs.translate("SENSING_DISTANCETO_POINTER", "puntero del ratón"), "_mouse_"],
  ])));
  safeInit("sensing_touchingobjectmenu", block => block.jsonInit(menuBlock("TOUCHINGOBJECTMENU", spriteOptions, "sensing", [
    [ScratchBlocks.ScratchMsgs.translate("SENSING_TOUCHINGOBJECT_POINTER", "puntero del ratón"), "_mouse_"],
    [ScratchBlocks.ScratchMsgs.translate("SENSING_TOUCHINGOBJECT_EDGE", "borde"), "_edge_"],
  ])));
  safeInit("control_create_clone_of_menu", block => block.jsonInit(menuBlock("CLONE_OPTION", () => nonEmpty(spriteOptions()), "control", vm.editingTarget?.isStage ? [] : [
    [ScratchBlocks.ScratchMsgs.translate("CONTROL_CREATECLONEOF_MYSELF", "mí mismo"), "_myself_"],
  ])));
  safeInit("sensing_of", block => block.jsonInit({
    message0: ScratchBlocks.Msg.SENSING_OF,
    args0: [
      {type: "field_dropdown", name: "PROPERTY", options: () => vm.editingTarget?.isStage ? [
        [ScratchBlocks.Msg.SENSING_OF_BACKDROPNUMBER, "backdrop #"],
        [ScratchBlocks.Msg.SENSING_OF_BACKDROPNAME, "backdrop name"],
        [ScratchBlocks.Msg.SENSING_OF_VOLUME, "volume"],
      ] : [
        [ScratchBlocks.Msg.SENSING_OF_XPOSITION, "x position"],
        [ScratchBlocks.Msg.SENSING_OF_YPOSITION, "y position"],
        [ScratchBlocks.Msg.SENSING_OF_DIRECTION, "direction"],
        [ScratchBlocks.Msg.SENSING_OF_COSTUMENUMBER, "costume #"],
        [ScratchBlocks.Msg.SENSING_OF_COSTUMENAME, "costume name"],
        [ScratchBlocks.Msg.SENSING_OF_SIZE, "size"],
        [ScratchBlocks.Msg.SENSING_OF_VOLUME, "volume"],
      ]},
      {type: "input_value", name: "OBJECT"},
    ],
    output: true,
    outputShape: ScratchBlocks.OUTPUT_SHAPE_ROUND,
    extensions: ["colours_sensing"],
  }));

  if (ScratchBlocks.CheckboxBubble) {
    ScratchBlocks.CheckboxBubble.prototype.isChecked = (blockId: string) => Boolean(vm.runtime?.monitorBlocks?._blocks?.[blockId]?.isMonitored);
  }
  if (ScratchBlocks.FieldNote) {
    ScratchBlocks.FieldNote.playNote_ = (note: number, extensionId: string) => vm.runtime.emit("PLAY_NOTE", note, extensionId);
  }
  return ScratchBlocks;
}
