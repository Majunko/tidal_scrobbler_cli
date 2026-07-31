
-- Tabla Users
CREATE TABLE Users (
Id INTEGER PRIMARY KEY AUTOINCREMENT,
Name TEXT NOT NULL,
Email TEXT UNIQUE NOT NULL,
Password TEXT NOT NULL,
CreatedAt DATE,
ExpirationDate DATE,
LastLoginDate DATE,
LastIP TEXT
);

CREATE TABLE UserTracks (
id INTEGER PRIMARY KEY AUTOINCREMENT,
user_id INTEGER NOT NULL,
artist TEXT NOT NULL,
album TEXT NOT NULL,
name TEXT NOT NULL,
date TEXT NOT NULL,
FOREIGN KEY (user_id) REFERENCES Users(Id)
);

-- Tabla History
CREATE TABLE History (
id INTEGER PRIMARY KEY AUTOINCREMENT,
user_id INTEGER NOT NULL,
Listened TEXT,
Duplicates TEXT,
Date TEXT,
FOREIGN KEY (user_id) REFERENCES Users(Id)
);


* Ejecutar el proceso en la WEB
* Interfaz para mostrar bases de datos (tracks)
* Interfaz para mostrar las canciones escuchadas, duplicadas (Si existe)
* Se pueda eliminar y vaya actualizando el JSON y la vista.
* De alguna manera muestre si una duplicada esta en las escuchadas tambien con un color igual, que el color varie o mirar que forma simple para el usuario.
* Se pueda eliminar los archivos JSON desde la interfaz (con pregunta, estar seguro).