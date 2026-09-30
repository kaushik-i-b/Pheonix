# Optional containerized setup for portability. The reference demo
# environment runs the app natively (no Docker); see examples/legacy-bank/run.sh.
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /src
COPY examples/legacy-bank/pom.xml ./pom.xml
RUN mvn -q dependency:go-offline
COPY examples/legacy-bank/src ./src
RUN mvn -q -DskipTests package

FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /src/target/corebank-legacy-0.9.3.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
