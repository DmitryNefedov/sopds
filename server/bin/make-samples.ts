#!/usr/bin/env node
// Generates a small sample book collection (FB2) for local testing / demos.
import fs from 'node:fs';
import path from 'node:path';
import config from '../src/config/index.js';

const dir = process.argv[2] || config.rootLib;
fs.mkdirSync(path.join(dir, 'russian'), { recursive: true });
fs.mkdirSync(path.join(dir, 'english'), { recursive: true });

interface SampleBook {
  file: string;
  title: string;
  first: string;
  last: string;
  genre: string;
  lang: string;
  series?: string;
  seriesNo?: number;
  annotation: string;
}

const fb2 = ({
  title,
  first,
  last,
  genre,
  lang,
  series,
  seriesNo,
  annotation,
}: Omit<SampleBook, 'file'>) => `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info>
<genre>${genre}</genre>
<author><first-name>${first}</first-name><last-name>${last}</last-name></author>
<book-title>${title}</book-title>
<annotation><p>${annotation}</p></annotation>
<lang>${lang}</lang>
${series ? `<sequence name="${series}" number="${seriesNo}"/>` : ''}
</title-info>
<document-info><date value="2021-01-01">2021</date></document-info>
</description>
<body><section><p>Sample body text.</p></section></body>
</FictionBook>`;

const books: SampleBook[] = [
  { file: 'russian/voyna-i-mir.fb2', title: 'Война и мир', first: 'Лев', last: 'Толстой', genre: 'prose_classic', lang: 'ru', annotation: 'Роман-эпопея.' },
  { file: 'russian/anna-karenina.fb2', title: 'Анна Каренина', first: 'Лев', last: 'Толстой', genre: 'prose_classic', lang: 'ru', annotation: 'Все счастливые семьи похожи друг на друга.' },
  { file: 'russian/master-i-margarita.fb2', title: 'Мастер и Маргарита', first: 'Михаил', last: 'Булгаков', genre: 'prose_classic', lang: 'ru', annotation: 'Рукописи не горят.' },
  { file: 'russian/dozor-1.fb2', title: 'Ночной Дозор', first: 'Сергей', last: 'Лукьяненко', genre: 'sf_fantasy', lang: 'ru', series: 'Дозоры', seriesNo: 1, annotation: 'Иные среди нас.' },
  { file: 'russian/dozor-2.fb2', title: 'Дневной Дозор', first: 'Сергей', last: 'Лукьяненко', genre: 'sf_fantasy', lang: 'ru', series: 'Дозоры', seriesNo: 2, annotation: 'Тёмные тоже люди.' },
  { file: 'english/1984.fb2', title: '1984', first: 'George', last: 'Orwell', genre: 'sf', lang: 'en', annotation: 'Big Brother is watching you.' },
  { file: 'english/animal-farm.fb2', title: 'Animal Farm', first: 'George', last: 'Orwell', genre: 'prose_classic', lang: 'en', annotation: 'All animals are equal.' },
  { file: 'english/dune-1.fb2', title: 'Dune', first: 'Frank', last: 'Herbert', genre: 'sf', lang: 'en', series: 'Dune Chronicles', seriesNo: 1, annotation: 'The spice must flow.' },
  { file: 'english/dune-2.fb2', title: 'Dune Messiah', first: 'Frank', last: 'Herbert', genre: 'sf', lang: 'en', series: 'Dune Chronicles', seriesNo: 2, annotation: 'A hero must be judged.' },
];

for (const b of books) {
  fs.writeFileSync(path.join(dir, b.file), fb2({ ...b, seriesNo: b.seriesNo || 0 }));
}
console.log(`Wrote ${books.length} sample books to ${dir}`);
