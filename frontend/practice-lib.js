/* 執譜機 drum practice library: rudiments, fills, grooves.

   Each pattern is written one slot at a time, bars separated by "|".
     grid: 16 = 16th notes (4 slots per beat), 8 = 8th notes (2 per beat),
           t8 = 8th-note triplets (3 per beat). Always 4 beats per bar.
     slot:  -            nothing
            R / L        right / left hand (snare unless @piece is given)
            K / HF       kick / hi-hat foot
            >            accent        g  ghost note
            f            flam (grace note from the other hand)
            d            drag (two grace notes from the other hand)
            @XX          piece: SN HH HO(open hi-hat) RD CR C2 T1 T2 FT
            +            played together, e.g. R@HH+K
*/
'use strict';
(function () {
  const G16 = 'R@CR+K - R@HH - R@HH+L - R@HH - R@HH+K - R@HH+K - R@HH+L - R@HH -';
  const G16_3 = 'R@CR+K - R@HH - R@HH+L - R@HH - R@HH+K - R@HH+K -';   // first 3 beats
  const G16_2 = 'R@CR+K - R@HH - R@HH+L - R@HH -';                     // first 2 beats

  const LIB = [
    // ------------------------------------------------------------ rudiments
    { id: 'single', cat: 'rudiment', name: '單擊 Single Stroke Roll', grid: 16, bpm: 80, sticking: true,
      slots: 'R L R L R L R L R L R L R L R L',
      tip: '左右手輪流，每下一樣大聲、一樣高度。由慢開始，聽住拍子機，兩隻手要平均。' },
    { id: 'double', cat: 'rudiment', name: '雙擊 Double Stroke Roll', grid: 16, bpm: 70, sticking: true,
      slots: 'R R L L R R L L R R L L R R L L',
      tip: '每隻手打兩下。第二下用手指 / 反彈帶出嚟，唔好比第一下細聲。' },
    { id: 'paradiddle', cat: 'rudiment', name: '單 Paradiddle', grid: 16, bpm: 70, sticking: true,
      slots: 'R> L R R L> R L L R> L R R L> R L L',
      tip: 'R L R R  L R L L。重音喺每組第一下，其餘細聲；重音之後隻手要即刻放低。' },
    { id: 'dbl-paradiddle', cat: 'rudiment', name: '雙 Paradiddle', grid: 't8', bpm: 70, sticking: true,
      slots: 'R> L R L R R L> R L R L L',
      tip: 'R L R L R R  L R L R L L，用三連音數：每組六下，重音喺頭。' },
    { id: 'triple-paradiddle', cat: 'rudiment', name: '三 Paradiddle', grid: 16, bpm: 70, sticking: true,
      slots: 'R> L R L R L R R L> R L R L R L L',
      tip: '單擊四下 + 雙擊，左右手輪流起頭。' },
    { id: 'paradiddle-diddle', cat: 'rudiment', name: 'Paradiddle-diddle', grid: 't8', bpm: 70, sticking: true,
      slots: 'R> L R R L L R> L R R L L',
      tip: 'R L R R L L。成日用嚟打 fill 同埋三連音 groove。' },
    { id: 'five-stroke', cat: 'rudiment', name: '五擊滾奏 Five Stroke Roll', grid: 16, bpm: 70, sticking: true,
      slots: 'R R L L R> - - - L L R R L> - - -',
      tip: '兩組雙擊 + 一下重音。重音嗰下要清楚，雙擊要細聲而平均。' },
    { id: 'six-stroke', cat: 'rudiment', name: '六擊滾奏 Six Stroke Roll', grid: 16, bpm: 70, sticking: true,
      slots: 'R> L L R R L> - - R> L L R R L> - -',
      tip: '重音 - 雙擊 - 雙擊 - 重音。打 fill 好好用：兩個重音擺喺 tom 度。' },
    { id: 'seven-stroke', cat: 'rudiment', name: '七擊滾奏 Seven Stroke Roll', grid: 16, bpm: 65, sticking: true,
      slots: 'R R L L R R L> - L L R R L L R> -',
      tip: '三組雙擊 + 重音，左右手輪流起頭。' },
    { id: 'flam', cat: 'rudiment', name: 'Flam', grid: 8, bpm: 70, sticking: true,
      slots: 'Rf - Lf - Rf - Lf - | Rf - Lf - Rf - Lf -',
      tip: '兩支棍差少少先後落：細聲嗰支（低位）快少少，大聲嗰支（高位）正拍。聽落係「flam」一聲，唔係兩下。' },
    { id: 'flam-tap', cat: 'rudiment', name: 'Flam Tap', grid: 16, bpm: 70, sticking: true,
      slots: 'Rf R Lf L Rf R Lf L Rf R Lf L Rf R Lf L',
      tip: 'Flam 之後同一隻手跟一下細聲 tap，似雙擊。' },
    { id: 'flam-accent', cat: 'rudiment', name: 'Flam Accent', grid: 't8', bpm: 65, sticking: true,
      slots: 'Rf L R Lf R L Rf L R Lf R L',
      tip: '三連音，每組第一下係 flam。' },
    { id: 'drag', cat: 'rudiment', name: 'Drag（Ruff）', grid: 8, bpm: 70, sticking: true,
      slots: 'Rd - Ld - Rd - Ld - | Rd - Ld - Rd - Ld -',
      tip: '前面兩下好細聲、好快嘅裝飾音（同一隻手彈兩下），然後另一隻手正拍落。' },
    { id: 'triplet-singles', cat: 'rudiment', name: '三連音單擊', grid: 't8', bpm: 75, sticking: true,
      slots: 'R> L R L> R L R> L R L> R L',
      tip: '每拍三下，重音左右手輪流 — 練兩隻手都可以做重音。' },
    { id: 'accent-shift', cat: 'rudiment', name: '16 分重音移位', grid: 16, bpm: 75, sticking: true,
      slots: 'R> L R L R> L R L R> L R L R> L R L | R L> R L R L> R L R L> R L R L> R L | R L R> L R L R> L R L R> L R L R> L | R L R L> R L R L> R L R L> R L R L>',
      tip: '四小節：重音喺 1、e、&、a。重音大聲、其餘細聲，手勢要分得清楚。' },

    // ------------------------------------------------------------ fills (groove bar + fill bar)
    { id: 'fill-sn1', cat: 'fill', name: '最後一拍 16 分 snare', grid: 16, bpm: 85, sticking: true,
      slots: `${G16} | ${G16_3} R L R L`,
      tip: '一小節 groove + 過門，循環返去第一拍落 crash。最基本嘅 fill：數住「4 e & a」。' },
    { id: 'fill-around', cat: 'fill', name: '16 分落 tom（成小節）', grid: 16, bpm: 80, sticking: true,
      slots: `${G16} | R L R L R@T1 L@T1 R@T1 L@T1 R@T2 L@T2 R@T2 L@T2 R@FT L@FT R@FT L@FT`,
      tip: 'Snare → Tom 1 → Tom 2 → Floor，每件四下，最後右手去 crash。' },
    { id: 'fill-2beats', cat: 'fill', name: '落 tom（最後兩拍）', grid: 16, bpm: 85, sticking: true,
      slots: `${G16} | ${G16_2} R L R@T1 L@T1 R@T2 L@T2 R@FT L@FT`,
      tip: '兩拍 fill：每件兩下。手由左向右行，落到 floor tom 之後右手好順咁去 crash 2（右邊嗰塊）。' },
    { id: 'fill-paradiddle', cat: 'fill', name: 'Paradiddle 落 tom', grid: 16, bpm: 75, sticking: true,
      slots: `${G16} | R> L R R L R@T1 L L R@T2 L R@T2 R@T2 L R@FT L L`,
      tip: 'Paradiddle 嘅右手逐拍落 tom（snare → tom 1 → tom 2 → floor），左手留喺 snare。' },
    { id: 'fill-triplet', cat: 'fill', name: '三連音落 tom', grid: 't8', bpm: 75, sticking: true,
      slots: 'R@CR+K - - R@HH+L - - R@HH+K - - R@HH+L - - | R L R L@T1 R@T1 L@T1 R@T2 L@T2 R@T2 L@FT R@FT L@FT',
      tip: '每拍三下，每拍換一件鼓。數「1 trip let 2 trip let」。' },
    { id: 'fill-six', cat: 'fill', name: '六擊滾奏 fill', grid: 16, bpm: 75, sticking: true,
      slots: `${G16} | ${G16_2} R>@T1 L L R R L>@FT R>@FT -`,
      tip: '六擊滾奏放喺最後兩拍，重音打 tom。' },
    { id: 'fill-linear', cat: 'fill', name: 'Linear fill（R L K）', grid: 16, bpm: 70, sticking: true,
      slots: `${G16} | R@T1 L@T1 K R@T1 L@T1 K R@T2 L@T2 K R@T2 L@T2 K R@FT L@FT K R@FT`,
      tip: '右手、左手、大鼓輪流，冇兩下同時打。三下一組放喺 4/4 入面，聽落有種「推前」嘅感覺。' },
    { id: 'fill-flam', cat: 'fill', name: 'Flam 落 tom（最後兩拍）', grid: 16, bpm: 75, sticking: true,
      slots: `${G16} | ${G16_2} Rf - Lf@T1 - Rf@T2 - Lf@FT -`,
      tip: '每下都係 flam，聲音厚啲。' },

    // ------------------------------------------------------------ grooves
    { id: 'rock8', cat: 'groove', name: 'Rock 8 分', grid: 8, bpm: 90,
      slots: 'R@HH+K R@HH R@HH+L R@HH R@HH+K R@HH+K R@HH+L R@HH',
      tip: '最常見嘅 groove：右手 hi-hat 8 分，左手 snare 喺 2、4，大鼓 1、3 同「3 &」。' },
    { id: 'hh16', cat: 'groove', name: '16 分 hi-hat（雙手）', grid: 16, bpm: 80,
      slots: 'R@HH+K L@HH R@HH L@HH R L@HH R@HH L@HH R@HH+K L@HH R@HH+K L@HH R L@HH R@HH L@HH',
      tip: '兩隻手輪流打 hi-hat，到 2、4 拍右手轉去 snare。' },
    { id: 'funk', cat: 'groove', name: 'Funk（ghost note）', grid: 16, bpm: 85,
      slots: 'R@HH+K - R@HH Lg R@HH+L - R@HH Lg R@HH+K Lg R@HH+K - R@HH+L - R@HH Lg',
      tip: 'Ghost note 要好細聲（棍離鼓皮一兩吋），2、4 拍嘅 snare 先係大聲。' },
    { id: 'halftime', cat: 'groove', name: 'Half-time', grid: 16, bpm: 80,
      slots: 'R@HH+K - R@HH - R@HH - R@HH+K - R@HH+L - R@HH - R@HH+K - R@HH -',
      tip: 'Snare 只喺第 3 拍，感覺慢一半。' },
    { id: 'disco', cat: 'groove', name: 'Disco', grid: 8, bpm: 110,
      slots: 'R@HH+K R@HO R@HH+K+L R@HO R@HH+K R@HO R@HH+K+L R@HO',
      tip: '四拍大鼓，喺「&」開 hi-hat（腳放鬆少少），正拍就踩實。' },
    { id: 'shuffle', cat: 'groove', name: 'Shuffle', grid: 't8', bpm: 85,
      slots: 'R@HH+K - R@HH R@HH+L - R@HH R@HH+K - R@HH R@HH+L - R@HH',
      tip: '三連音嘅第一同第三下，「長 - 短」嘅感覺。' },
    { id: 'ride', cat: 'groove', name: 'Ride + hi-hat 腳', grid: 8, bpm: 90,
      slots: 'R@RD+K R@RD R@RD+L+HF R@RD R@RD+K R@RD+K R@RD+L+HF R@RD',
      tip: '右手去 ride，左腳喺 2、4 踩 hi-hat。' },
    { id: 'kick16', cat: 'groove', name: '大鼓 16 分變化', grid: 16, bpm: 80,
      slots: 'R@HH+K - R@HH - R@HH+L - R@HH K R@HH - R@HH+K K R@HH+L - R@HH K',
      tip: '大鼓踩喺「a」同「e」，hi-hat 同 snare 保持穩定。' },

    // ------------------------------------------------------------ coordination
    { id: 'paradiddle-groove', cat: 'coord', name: 'Paradiddle groove', grid: 16, bpm: 75, sticking: true,
      slots: 'R@HH+K Lg R@HH R@HH L> R@HH Lg Lg R@HH+K Lg R@HH R@HH L> R@HH Lg Lg',
      tip: 'Paradiddle 拆開：右手 hi-hat、左手 snare（2、4 拍重音，其餘 ghost）。' },
    { id: 'hands-feet', cat: 'coord', name: '手腳輪流', grid: 16, bpm: 70, sticking: true,
      slots: 'R L K K R L K K R L K K R L K K',
      tip: '兩下手、兩下大鼓。大鼓要同手一樣平均。' },
    { id: 'hh-foot', cat: 'coord', name: '單擊 + hi-hat 腳', grid: 16, bpm: 70, sticking: true,
      slots: 'R+K L R L R+HF L R L R+K L R L R+HF L R L',
      tip: '雙手單擊唔停，腳打 1、3 大鼓，2、4 踩 hi-hat。' },
  ];

  const CATS = [
    { id: 'rudiment', name: '基本功 Rudiments' },
    { id: 'fill', name: '過門 Fills' },
    { id: 'groove', name: '節奏 Grooves' },
    { id: 'coord', name: '手腳協調' },
  ];

  window.JPPracticeLib = { LIB, CATS };
})();
