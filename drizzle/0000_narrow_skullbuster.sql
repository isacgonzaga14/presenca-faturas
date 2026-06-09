CREATE TABLE `user_config` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`empresaNome` varchar(255) NOT NULL DEFAULT 'PRESENÇOBRIGATÓRIA - UNIPESSOAL LDA',
	`empresaNif` varchar(20) NOT NULL DEFAULT '518604870',
	`empresaMorada` varchar(500) NOT NULL DEFAULT 'Rua Miguel Pais, Nº 46, 1º F, Barreiro, 2830-356, Portugal',
	`tiposJson` text NOT NULL DEFAULT ('["GERAR FATURA","RECIBO VERDE","RECIBO","RECEBIMENTO","FATURA COMPRA","MANUTENÇÃO DE CONTA","PAGAMENTO AO ESTADO","AVENÇA CONTAB","SEGURO BANCARIO","RECIBO SALARIO"]'),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_config_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_mes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`mes` varchar(20) NOT NULL,
	`ano` int NOT NULL,
	`movimentosJson` text NOT NULL DEFAULT ('[]'),
	`docGerado` text NOT NULL DEFAULT (''),
	`finalizado` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_mes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openId` varchar(64) NOT NULL,
	`name` text,
	`email` varchar(320),
	`loginMethod` varchar(64),
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastSignedIn` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_openId_unique` UNIQUE(`openId`)
);
